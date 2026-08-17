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
import { getOldestNonSummaryTurns } from '../../runtime/turn-utils.js';

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

  if (sessionManager.getTurns().length === 0) {
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

  const softThreshold = config.softThresholdPercent / 100;
  const summaryBudget = config.summaryBudgetPercent / 100;

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

  // Convergence loop: keep compacting until usage is below the soft threshold
  // or no more progress can be made. Each iteration recalculates metrics from
  // the current session state, since compaction mutates the session.
  const MAX_COMPACTION_ITERATIONS = 5;
  for (let iteration = 0; iteration < MAX_COMPACTION_ITERATIONS; iteration++) {
    const turns = sessionManager.getTurns();
    if (turns.length === 0) {
      break;
    }

    const metrics = summarizeTokenCounts({
      turns,
      baseSystemMessages: input.baseSystemMessages,
      fragmentMessages: input.fragmentMessages,
      contextWindowTokens,
    });

    if (metrics.usagePercent <= softThreshold) {
      break;
    }

    // Self-purge: drop oldest summary until summary region is under budget.
    if (metrics.summaryPercent > summaryBudget) {
      const summaryTurns = sessionManager.getSummaryTurns();
      if (summaryTurns.length === 0) {
        break; // no progress possible
      }
      const dropped = sessionManager.dropSummaryTurnById(
        summaryTurns.at(-1)!.id
      );
      if (!dropped) {
        break; // no progress possible
      }
      logger.warn(
        `compaction: dropped oldest summary turn to keep summary region within ${(summaryBudget * 100).toFixed(0)}% of context window (was ${(metrics.summaryPercent * 100).toFixed(1)}%).`
      );
      emitEvent?.({
        kind: 'compaction',
        message: 'Dropped oldest summary turn',
        status: 'completed',
      });
      continue; // recalculate metrics and try again
    }

    // Slice-and-summarize: usage above threshold and enough turns to compact.
    const nonSummaryCount = turns.filter(
      turn => turn.kind !== 'summary'
    ).length;
    if (nonSummaryCount < config.minTurnsToCompact) {
      break; // not enough non-summary turns to compact
    }

    const desiredSlice = Math.floor(
      (nonSummaryCount * config.slicePercent) / 100
    );
    const sliceSize = Math.max(
      config.minTurnsToCompact,
      Math.min(desiredSlice, nonSummaryCount)
    );

    if (sliceSize <= 0) {
      break;
    }

    // Summaries are prepended at the head; normal turns are appended at the
    // tail. The oldest non-summary turns sit right after the summary region.
    // getOldestNonSummaryTurns iterates forward, skipping summaries, to
    // collect exactly these turns.
    const slice = getOldestNonSummaryTurns(turns, sliceSize);
    const transcript = formatTurnsForSummary(slice);

    const summaryUserPrompt =
      `Summarize the following ${slice.length} conversation turn(s) in at most ` +
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

      const dropped = sessionManager.dropTurnsByIds(slice.map(t => t.id));
      if (dropped.length !== slice.length) {
        logger.warn(
          `compaction: expected to drop ${slice.length} turns but dropped ${dropped.length}; proceeding with partial drop`
        );
      }
      sessionManager.prependSystemTurn(SUMMARY_PREFIX + summaryText, {
        kind: 'summary',
      });

      logger.info(
        `compaction: compacted ${slice.length} oldest turn(s) into a summary.`
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
      break; // a failed summary means no progress this round; stop
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
