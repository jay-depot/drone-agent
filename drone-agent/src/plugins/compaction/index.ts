import {
  estimateMessageTokens,
  estimateTurnTokens,
  type DroneChatMessage,
  type DroneCompactionConfig,
  type DroneConversationEvent,
  type DroneLlmProvider,
  type DroneLogger,
  type DronePlugin,
  type DroneSessionTurn,
} from 'drone-core';
import type { DroneSessionManager } from '../../runtime/session-manager.js';

type RegistrationContext = {
  config: DroneCompactionConfig;
  getProvider: () => DroneLlmProvider;
  getModel: () => string;
  sessionManager: DroneSessionManager;
  logger: DroneLogger;
  compactionInFlight: { value: boolean };
  emitEvent?: (event: DroneConversationEvent) => void;
};

const SUMMARY_PREFIX = 'Conversation summary (compacted):\n';

function resolveContextWindow(
  provider: DroneLlmProvider,
  model: string,
  fallback: number
): Promise<number> {
  const probe = provider.getContextWindowInfo?.({ model });
  if (!probe) {
    return Promise.resolve(fallback);
  }
  return probe
    .then(info => info?.contextWindowTokens ?? fallback)
    .catch(() => fallback);
}

function formatTurnsForSummary(turns: DroneSessionTurn[]): string {
  return turns
    .map((turn, index) => {
      const parts = turn.messages.map(message => {
        const header = `[${message.role}]`;
        const body = message.content.length > 0 ? message.content : '(empty)';
        if (message.toolCalls && message.toolCalls.length > 0) {
          const toolSummary = message.toolCalls
            .map(
              tc => `  tool_call: ${tc.name}(${JSON.stringify(tc.arguments)})`
            )
            .join('\n');
          return `${header} ${body}\n${toolSummary}`;
        }
        if (message.toolName) {
          return `${header} (tool=${message.toolName}) ${body}`;
        }
        return `${header} ${body}`;
      });
      return `--- Turn ${index + 1} ---\n${parts.join('\n')}`;
    })
    .join('\n');
}

function summarizeTokenCounts(input: {
  turns: DroneSessionTurn[];
  baseSystemMessages: DroneChatMessage[];
  fragmentMessages: DroneChatMessage[];
  contextWindowTokens: number;
}): {
  usagePercent: number;
  summaryPercent: number;
  summaryTokens: number;
  promptTokens: number;
} {
  const summaryTurns = input.turns.filter(t => t.kind === 'summary');
  const summaryTokens = summaryTurns.reduce(
    (sum, turn) => sum + estimateTurnTokens(turn),
    0
  );

  const allSystemMessages = [
    ...input.baseSystemMessages,
    ...input.fragmentMessages,
  ];
  const systemTokens = allSystemMessages.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0
  );
  const sessionTokens = input.turns.reduce(
    (sum, turn) => sum + estimateTurnTokens(turn),
    0
  );
  const promptTokens = systemTokens + sessionTokens;

  return {
    usagePercent:
      input.contextWindowTokens > 0
        ? promptTokens / input.contextWindowTokens
        : 0,
    summaryPercent:
      input.contextWindowTokens > 0
        ? summaryTokens / input.contextWindowTokens
        : 0,
    summaryTokens,
    promptTokens,
  };
}

async function maybeCompact(input: {
  context: RegistrationContext;
  baseSystemMessages: DroneChatMessage[];
  fragmentMessages: DroneChatMessage[];
}): Promise<void> {
  const { config, sessionManager, getProvider, getModel, logger, emitEvent } =
    input.context;

  if (!config.enabled) {
    return;
  }

  const turns = sessionManager.getTurns();

  if (turns.length === 0) {
    return;
  }

  const provider = getProvider();
  const model = getModel();

  // Conservative fallback: derive a context-window estimate from the static
  // system + fragment tokens and the configured soft threshold, so we can
  // reason about usage even when Ollama's probe is unavailable.
  const fallbackContextWindow = Math.max(
    1,
    Math.round(
      (input.baseSystemMessages.reduce(
        (sum, m) => sum + estimateMessageTokens(m),
        0
      ) +
        input.fragmentMessages.reduce(
          (sum, m) => sum + estimateMessageTokens(m),
          0
        )) /
        Math.max(0.01, config.softThresholdPercent / 100)
    )
  );

  const contextWindowTokens = await resolveContextWindow(
    provider,
    model,
    fallbackContextWindow
  );

  const metrics = summarizeTokenCounts({
    turns,
    baseSystemMessages: input.baseSystemMessages,
    fragmentMessages: input.fragmentMessages,
    contextWindowTokens,
  });

  const softThreshold = config.softThresholdPercent / 100;
  const summaryBudget = config.summaryBudgetPercent / 100;

  // Self-purge: drop oldest summary until summary region is under budget.
  if (metrics.summaryPercent > summaryBudget) {
    const summaryTurns = sessionManager.getSummaryTurns();
    if (summaryTurns.length > 0) {
      const dropped = sessionManager.dropSummaryTurnById(summaryTurns[0].id);
      if (dropped) {
        logger.warn(
          `compaction: dropped oldest summary turn to keep summary region within ${(summaryBudget * 100).toFixed(0)}% of context window (was ${(metrics.summaryPercent * 100).toFixed(1)}%).`
        );
        emitEvent?.({
          kind: 'compaction',
          message: 'Dropped oldest summary turn',
          status: 'completed',
        });
      }
    }
    input.context.compactionInFlight.value = false;
    return;
  }

  // Slice-and-summarize: usage above threshold and enough turns to compact.
  if (
    metrics.usagePercent > softThreshold &&
    turns.length >= config.minTurnsToCompact
  ) {
    const desiredSlice = Math.floor((turns.length * config.slicePercent) / 100);
    const sliceSize = Math.max(
      config.minTurnsToCompact,
      Math.min(desiredSlice, turns.length - 1)
    );

    if (sliceSize <= 0) {
      input.context.compactionInFlight.value = false;
      return;
    }

    const slice = turns.slice(0, sliceSize);
    const transcript = formatTurnsForSummary(slice);

    const summarySystemPrompt =
      'You are a conversation summarizer. Produce a concise summary of the ' +
      'transcript below. Aim for a brief bullet list. Do not include greetings or ' +
      'pleasantries. Stay under the requested token budget. Prioritize ' +
      'including information in the summary according to the following ' +
      'order from most to least important:\n' +
      '1. User input, instruction, questions, and decisions. Preserve these ' +
      'verbatim.\n' +
      "2. Any context needed to understand the user's input, instructions, " +
      'questions, and decisions. For instance, if the user says "Yes, like that," ' +
      'whatever "that" refers to needs to be included in the summary, if ' +
      'it is available.\n' +
      '3. Architectural or design information.\n' +
      '4. Any other relevant information.\n\n' +
      'Detailed tool calls and results should be discarded. Provide a summary ' +
      'of what was done if it is relevant and only if space allows.\n\n' +
      `If any information is missing or ambiguous, note that in the summary. ` +
      `Do not make anything up. If information is not in the transcript, ` +
      `skip it. If you can't just skip it, note it.`;

    const summaryUserPrompt =
      `Summarize the following ${sliceSize} conversation turn(s) in at most ` +
      `${config.summaryMaxTokens} tokens:\n\n${transcript}`;

    emitEvent?.({
      kind: 'compaction',
      message: `Compacting ${sliceSize} turn(s)...`,
      status: 'started',
    });

    try {
      const response = await provider.chat({
        model,
        tools: [],
        messages: [
          { role: 'system', content: summarySystemPrompt },
          { role: 'user', content: summaryUserPrompt },
        ],
      });

      const summaryText = (response.message ?? '').trim();
      if (summaryText.length === 0) {
        throw new Error('LLM Provider returned an empty summary.');
      }

      sessionManager.dropOldestNonSummaryTurns(sliceSize);
      sessionManager.prependSystemTurn(SUMMARY_PREFIX + summaryText, {
        kind: 'summary',
      });

      logger.info(
        `compaction: compacted ${sliceSize} oldest turn(s) into a summary.`
      );
      emitEvent?.({
        kind: 'compaction',
        message: `Compacted ${sliceSize} turn(s)`,
        status: 'completed',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode = (error as any)?.status_code;
      const statusSuffix = statusCode ? ` (HTTP ${statusCode})` : '';
      logger.warn(
        `compaction: summary failed; leaving session untouched: ${message}${statusSuffix}`
      );
      emitEvent?.({
        kind: 'compaction',
        message: `Compaction failed: ${message}${statusSuffix}`,
        status: 'failed',
      });
    }
  }

  input.context.compactionInFlight.value = false;
}

async function runCompaction(
  context: RegistrationContext,
  systemPrompt: string
): Promise<void> {
  const baseSystemMessages: DroneChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];
  const fragmentMessages: DroneChatMessage[] = [];
  await maybeCompact({
    context,
    baseSystemMessages,
    fragmentMessages,
  });
}

export type CompactionCapability = {
  forceEvaluate: () => Promise<void>;
};

export type CompactionPluginDeps = {
  sessionManager: DroneSessionManager;
  getModel: () => string;
  getProvider: () => DroneLlmProvider;
  /**
   * Optional callback to emit conversation events for TUI visibility.
   * When provided, compaction will emit 'started', 'completed', and
   * 'failed' events so the TUI can show compaction progress in the
   * tail region and commit entries to scrollback.
   */
  emitEvent?: (event: DroneConversationEvent) => void;
};
export function createCompactionPlugin(
  deps: CompactionPluginDeps
): DronePlugin {
  const sessionManager = deps.sessionManager;
  const getModel = deps.getModel;
  const getProvider = deps.getProvider;

  return {
    metadata: {
      id: 'compaction',
      name: 'Context Compaction',
      version: '0.1.0',
      description:
        'Proactively summarizes oldest conversation turns to keep usage below the configured soft threshold.',
      defaultEnabled: true,
    },
    register: async registration => {
      const config = registration.getConfig().compaction;

      const context: RegistrationContext = {
        config,
        getProvider,
        getModel,
        sessionManager,
        logger: registration.logger,
        compactionInFlight: { value: false },
        emitEvent: deps.emitEvent,
      };

      registration.registerHelp(
        'Context Compaction: proactively summarizes oldest conversation turns when usage exceeds the configured soft threshold. Set compaction.enabled=false in .drone-agent/config.json to disable.'
      );

      const hookBody = async (): Promise<void> => {
        if (!config.enabled) {
          return;
        }
        if (context.compactionInFlight.value) {
          return;
        }
        context.compactionInFlight.value = true;

        try {
          await runCompaction(context, registration.getConfig().systemPrompt);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          context.logger.warn(
            `compaction: error during evaluation; leaving session untouched: ${message}`
          );
        } finally {
          context.compactionInFlight.value = false;
        }
      };

      registration.hooks.onBeforePrompt(hookBody);
      registration.hooks.onAfterToolCall(hookBody);

      const capability: CompactionCapability = {
        forceEvaluate: async () => {
          if (!config.enabled || context.compactionInFlight.value) {
            return;
          }
          context.compactionInFlight.value = true;
          try {
            await runCompaction(context, registration.getConfig().systemPrompt);
          } finally {
            context.compactionInFlight.value = false;
          }
        },
      };
      registration.offer(capability);

      registration.hooks.onPluginsLoaded(async () => {
        registration.logger.info(
          `compaction ready (strategy=${config.strategy}, threshold=${config.softThresholdPercent}%, slice=${config.slicePercent}%)`
        );
      });
    },
  };
}
