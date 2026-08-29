import {
  DroneLlmError,
  estimateMessageTokens,
  estimateTurnTokens,
  type DroneChatMessage,
  type DroneCompactionConfig,
  type DroneConversationEvent,
  type DroneImageContent,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DroneLogger,
  type DronePlugin,
  type DroneSlashCommandContext,
  type DroneSessionTurn,
} from 'drone-core';
import type { DroneSessionManager } from '../../runtime/session-manager.js';
import { getOldestNonSummaryTurns } from '../../runtime/turn-utils.js';

type RegistrationContext = {
  config: DroneCompactionConfig;
  /** LLM broker capability used to resolve the summarizer role per round. */
  llm: DroneLlmCapability | undefined;
  sessionManager: DroneSessionManager;
  logger: DroneLogger;
  compactionInFlight: { value: boolean };
  emitEvent?: (event: DroneConversationEvent) => void;
  /** Queues a one-shot, non-persisted system reminder for the next LLM call. */
  queueSystemReminder: (content: string) => void;
  /** Canonical names of currently-mounted tools (for reminder copy). */
  listMountedToolNames: () => string[];
  /**
   * Edge-trigger state for the pre-compaction nudge: fires once per excursion
   * into the warning band, re-arms when usage falls below the band floor.
   */
  nudgeArmed: { value: boolean };
  buildFragmentMessages: () => Promise<DroneChatMessage[]>;
};

const SUMMARY_PREFIX = 'Conversation summary (compacted):\n';

function formatTokensRemaining(tokens: number): string {
  if (tokens < 2000) {
    return String(Math.round(tokens / 100) * 100);
  }
  return `~${Math.round(tokens / 1000)}k`;
}

function detectMountedToolPrefixes(names: string[]): {
  notepad: boolean;
  todo: boolean;
} {
  let notepad = false;
  let todo = false;
  for (const name of names) {
    if (!notepad && name.startsWith('notepad__')) notepad = true;
    if (!todo && name.startsWith('todo__')) todo = true;
  }
  return { notepad, todo };
}

function buildReminderText(
  figure: string,
  mounted: { notepad: boolean; todo: boolean }
): string {
  const options: string[] = [];
  if (mounted.notepad) {
    options.push('`notepad__manage` (working notes)');
  }
  if (mounted.todo) {
    options.push('`todo__manage_list` (task state)');
  }
  const toolClause =
    options.length > 0
      ? ` If there are constraints, decisions, discoveries, or next steps you will need later, persist them now using ${options.join(' or ')}.`
      : '';
  return (
    'Context is approaching the compaction threshold (' +
    `${figure} tokens before older conversation turns are summarized).` +
    toolClause
  );
}

type CompactionOptions = {
  force?: boolean;
  slicePercentOverride?: number;
  /** Cap on the number of slice-and-summarize rounds in a single maybeCompact call. */
  maxIterations?: number;
};

function calculateFallbackContextWindow(
  baseSystemMessages: DroneChatMessage[],
  fragmentMessages: DroneChatMessage[],
  softThresholdPercent: number
): number {
  const totalSystemTokens = [...baseSystemMessages, ...fragmentMessages].reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0
  );

  return Math.max(
    1,
    Math.round(totalSystemTokens / Math.max(0.01, softThresholdPercent / 100))
  );
}

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

function formatTurnsForSummary(
  turns: DroneSessionTurn[],
  startIndex = 0
): string {
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
        const imageLines = (message.images ?? [])
          .map(img =>
            img.description
              ? `  image: ${img.description}`
              : '  image: (undescribed)'
          )
          .join('\n');
        return imageLines
          ? `${header} ${body}\n${imageLines}`
          : `${header} ${body}`;
      });
      return `--- Turn ${startIndex + index + 1} ---\n${parts.join('\n')}`;
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
  options: CompactionOptions;
}): Promise<void> {
  const { config, sessionManager, llm, logger, emitEvent } = input.context;

  if (!config.enabled && !input.options.force) {
    return;
  }

  if (sessionManager.getTurns().length === 0) {
    return;
  }

  if (!llm) {
    logger.warn(
      'compaction: LLM broker capability unavailable; skipping summarization.'
    );
    return;
  }

  const fallbackContextWindow = calculateFallbackContextWindow(
    input.baseSystemMessages,
    input.fragmentMessages,
    config.softThresholdPercent
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
  // or no more progress can be made.
  const MAX_COMPACTION_ITERATIONS = 5;
  const maxIterations =
    input.options.maxIterations ?? MAX_COMPACTION_ITERATIONS;
  // Set once compaction acts (purge or summarize) during this call, so the
  // nudge stays quiet for the rest of the evaluation — right after
  // compaction is the wrong moment to warn. The next hook fire re-checks.
  let compactedDuringThisCall = false;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Resolve the summarizer role fresh each round so a mid-loop model change
    // (or a role that only becomes available later) is picked up.
    const resolved = llm.resolveModelForRole('summarizer');
    const contextWindowTokens = await resolveContextWindow(
      resolved.provider,
      resolved.model,
      fallbackContextWindow
    );

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

    // Pre-compaction nudge: fire once per excursion into the warning band
    // [soft - margin, soft]. Must run before the soft-threshold early-bail
    // so a sub-threshold evaluation still delivers the reminder. Overshoot
    // (usage past the soft threshold) never warns — compaction handles it on
    // this same evaluation.
    const marginFraction = Math.max(0, config.nudgeMarginPercent) / 100;
    if (
      !input.options.force &&
      input.context.nudgeArmed.value &&
      !compactedDuringThisCall &&
      metrics.usagePercent >= softThreshold - marginFraction &&
      metrics.usagePercent <= softThreshold
    ) {
      input.context.nudgeArmed.value = false;
      const tokensUntilSoft = Math.max(
        0,
        Math.round((softThreshold - metrics.usagePercent) * contextWindowTokens)
      );
      const figure = formatTokensRemaining(tokensUntilSoft);
      input.context.queueSystemReminder(
        buildReminderText(
          figure,
          detectMountedToolPrefixes(input.context.listMountedToolNames())
        )
      );
      emitEvent?.({
        kind: 'notice',
        content: `[Compaction in ${figure} tokens]`,
      });
    }
    if (metrics.usagePercent < softThreshold - marginFraction) {
      input.context.nudgeArmed.value = true;
    }

    if (!input.options.force && metrics.usagePercent <= softThreshold) {
      break;
    }

    // Self-purge: drop oldest summary until the summary region is under budget.
    if (metrics.summaryPercent > summaryBudget) {
      const summaryTurns = sessionManager.getSummaryTurns();
      if (summaryTurns.length === 0) {
        break;
      }
      const dropped = sessionManager.dropSummaryTurnById(summaryTurns[0]!.id);
      if (!dropped) {
        break;
      }
      logger.warn(
        `compaction: dropped oldest summary turn to keep summary region within ${(summaryBudget * 100).toFixed(0)}% of context window (was ${(metrics.summaryPercent * 100).toFixed(1)}%).`
      );
      compactedDuringThisCall = true;
      emitEvent?.({
        kind: 'compaction',
        message: 'Dropped oldest summary turn',
        status: 'completed',
      });
      continue;
    }

    // Slice-and-summarize: usage above threshold and enough turns to compact.
    const nonSummaryCount = turns.filter(
      turn => turn.kind !== 'summary'
    ).length;
    if (nonSummaryCount < config.minTurnsToCompact) {
      break;
    }

    const slicePercent =
      input.options.slicePercentOverride ?? config.slicePercent;
    const desiredSlice = Math.floor((nonSummaryCount * slicePercent) / 100);
    const sliceSize = Math.max(
      config.minTurnsToCompact,
      Math.min(desiredSlice, nonSummaryCount)
    );

    if (sliceSize <= 0) {
      break;
    }

    // Summaries form a chronological block at the head; normal turns are
    // appended at the tail. getOldestNonSummaryTurns iterates forward,
    // skipping summaries, to collect exactly these turns.
    const slice = getOldestNonSummaryTurns(turns, sliceSize);
    // Pre-compaction flush (D4): describe undescribed images so the summary
    // captures their semantics before image bytes are destroyed.
    await flushImageDescriptions(slice, llm);
    const transcript = formatTurnsForSummary(slice);

    const summaryUserPrompt =
      `Summarize the following ${slice.length} conversation turn(s) in at most ` +
      `${config.summaryMaxTokens} tokens:\n\n${transcript}`;

    emitEvent?.({
      kind: 'compaction',
      message: `Compacting ${sliceSize} turn(s) with ${resolved.providerId}/${resolved.model}...`,
      status: 'started',
    });

    try {
      const response = await resolved.provider.chat({
        model: resolved.model,
        reasoningLevel: resolved.reasoningLevel,
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
      compactedDuringThisCall = true;
      emitEvent?.({
        kind: 'compaction',
        message: `Compacted ${sliceSize} turn(s) with ${resolved.providerId}/${resolved.model}`,
        status: 'completed',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const statusCode =
        error instanceof DroneLlmError ? error.status : undefined;
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
}

async function runCompaction(
  context: RegistrationContext,
  systemPrompt: string,
  options: CompactionOptions = {}
): Promise<void> {
  const baseSystemMessages: DroneChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];
  const fragmentMessages = await context.buildFragmentMessages();
  await maybeCompact({
    context,
    baseSystemMessages,
    fragmentMessages,
    options,
  });
}

export type CompactionStatus = {
  enabled: boolean;
  config: DroneCompactionConfig;
  turns: {
    total: number;
    nonSummary: number;
    summary: number;
    oldestNonSummaryIndex: number | null;
  };
  contextWindow: {
    softThresholdPercent: number;
    currentUsagePercent: number;
    summaryBudgetPercent: number;
    currentSummaryPercent: number;
  };
  summaries: Array<{
    id: string;
    preview: string;
    tokenCount: number;
  }>;
};

export type CompactionCapability = {
  forceEvaluate: () => Promise<void>;
  forceEvaluateAll: () => Promise<void>;
  getStatus: () => Promise<CompactionStatus>;
  dropSummary: (id: string) => Promise<boolean>;
  dropAllSummaries: () => Promise<number>;
  dropOldestSummaries: (count: number) => Promise<number>;
};

async function handleCompact(
  cap: CompactionCapability,
  ctx: DroneSlashCommandContext,
  { all }: { all: boolean }
): Promise<boolean> {
  const status = await cap.getStatus();

  if (!status.enabled) {
    ctx.logger.warn(
      'Compaction is disabled in config; forcing manual compaction.'
    );
  }

  if (status.turns.nonSummary < status.config.minTurnsToCompact) {
    ctx.logger.warn(
      `Only ${status.turns.nonSummary} non-summary turn(s); need at least ${status.config.minTurnsToCompact} to compact`
    );
    return true;
  }

  if (all) {
    await cap.forceEvaluateAll();
    ctx.logger.info('Compacted ALL non-summary turns');
  } else {
    await cap.forceEvaluate();
    ctx.logger.info('Compacted oldest non-summary turns');
  }
  return true;
}

async function handleShow(
  cap: CompactionCapability,
  ctx: DroneSlashCommandContext
): Promise<boolean> {
  const status = await cap.getStatus();
  if (status.summaries.length === 0) {
    ctx.logger.info('No compaction summaries in current context');
    return true;
  }

  ctx.logger.info('Compaction summaries (newest first):');
  for (const s of status.summaries) {
    ctx.logger.info(
      `  ${s.id.slice(0, 8)}  ${s.tokenCount} tokens  ${s.preview}`
    );
  }
  ctx.logger.info(
    `Total: ${status.summaries.length} summary turn(s), ${(
      status.contextWindow.currentSummaryPercent * 100
    ).toFixed(1)}% of budget`
  );
  return true;
}

async function handleDrop(
  cap: CompactionCapability,
  ctx: DroneSlashCommandContext,
  args: string[]
): Promise<boolean> {
  if (args.length === 0) {
    ctx.logger.warn('Usage: /compact drop <id|all|N>');
    return true;
  }

  const target = args[0].toLowerCase();

  if (target === 'all') {
    const dropped = await cap.dropAllSummaries();
    ctx.logger.info(`Dropped ${dropped} summary turn(s)`);
  } else if (/^\d+$/.test(target)) {
    const dropped = await cap.dropOldestSummaries(parseInt(target, 10));
    ctx.logger.info(`Dropped ${dropped} oldest summary turn(s)`);
  } else {
    const ok = await cap.dropSummary(target);
    if (ok) {
      ctx.logger.info(`Dropped summary ${target}`);
    } else {
      ctx.logger.warn(`Summary not found: ${target}`);
    }
  }
  return true;
}

export type CompactionPluginDeps = {
  sessionManager: DroneSessionManager;
  /**
   * Optional callback to emit conversation events for TUI visibility.
   * When provided, compaction will emit 'started', 'completed', and
   * 'failed' events so the TUI can show compaction progress in the
   * tail region and commit entries to scrollback.
   */
  emitEvent?: (event: DroneConversationEvent) => void;
  /**
   * Build the list of system messages from registered prompt fragments.
   * Used to account for fragment tokens in context-window calculations.
   * Defaults to returning an empty array if not provided.
   */
  buildFragmentMessages?: () => Promise<DroneChatMessage[]>;
};
export function createCompactionPlugin(
  deps: CompactionPluginDeps
): DronePlugin {
  const sessionManager = deps.sessionManager;

  return {
    metadata: {
      id: 'compaction',
      name: 'Context Compaction',
      version: '0.1.0',
      description:
        'Proactively summarizes oldest conversation turns to keep usage below the configured soft threshold.',
      defaultEnabled: true,
      dependencies: [{ id: 'llm', optional: true }],
    },
    register: async registration => {
      const config = registration.getConfig().compaction;
      const llm = registration.request<DroneLlmCapability>('llm');

      const runtime = registration.request<{
        queueSystemReminder?: (content: string) => void;
      }>('runtime');

      const context: RegistrationContext = {
        config,
        llm,
        sessionManager,
        logger: registration.logger,
        compactionInFlight: { value: false },
        emitEvent: deps.emitEvent,
        queueSystemReminder: content => {
          runtime?.queueSystemReminder?.(content);
        },
        nudgeArmed: { value: true },
        listMountedToolNames: () =>
          registration.listMountedTools().map(tool => tool.name),
        buildFragmentMessages: deps.buildFragmentMessages ?? (async () => []),
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
          if (context.compactionInFlight.value) {
            return;
          }
          context.compactionInFlight.value = true;
          try {
            await runCompaction(
              context,
              registration.getConfig().systemPrompt,
              { force: true, maxIterations: 1 }
            );
          } finally {
            context.compactionInFlight.value = false;
          }
        },
        forceEvaluateAll: async () => {
          if (context.compactionInFlight.value) {
            return;
          }
          context.compactionInFlight.value = true;
          try {
            await runCompaction(
              context,
              registration.getConfig().systemPrompt,
              {
                force: true,
                slicePercentOverride: 100,
                maxIterations: 1,
              }
            );
          } finally {
            context.compactionInFlight.value = false;
          }
        },
        getStatus: async () => {
          const turns = sessionManager.getTurns();
          const summaryTurns = turns.filter(t => t.kind === 'summary');
          const nonSummaryTurns = turns.filter(t => t.kind !== 'summary');

          const baseSystemMessages: DroneChatMessage[] = [
            {
              role: 'system',
              content: registration.getConfig().systemPrompt,
            },
          ];
          const fragmentMessages = await context.buildFragmentMessages();
          const fallbackContextWindow = calculateFallbackContextWindow(
            baseSystemMessages,
            fragmentMessages,
            config.softThresholdPercent
          );

          const contextWindowTokens = llm
            ? await resolveContextWindow(
                llm.getActiveProvider(),
                llm.getModel(),
                fallbackContextWindow
              )
            : fallbackContextWindow;
          const counts = summarizeTokenCounts({
            turns,
            baseSystemMessages,
            fragmentMessages,
            contextWindowTokens,
          });

          return {
            enabled: config.enabled,
            config,
            turns: {
              total: turns.length,
              nonSummary: nonSummaryTurns.length,
              summary: summaryTurns.length,
              oldestNonSummaryIndex: nonSummaryTurns[0]
                ? turns.indexOf(nonSummaryTurns[0])
                : null,
            },
            contextWindow: {
              softThresholdPercent: config.softThresholdPercent,
              currentUsagePercent: counts.usagePercent,
              summaryBudgetPercent: config.summaryBudgetPercent,
              currentSummaryPercent: counts.summaryPercent,
            },
            summaries: summaryTurns.map(t => ({
              id: t.id,
              preview: t.messages[0]?.content?.slice(0, 80) ?? '',
              tokenCount: estimateTurnTokens(t),
            })),
          };
        },
        dropSummary: async id =>
          sessionManager.dropSummaryTurnById(id) !== null,
        dropAllSummaries: async () => {
          const ids = sessionManager.getSummaryTurns().map(t => t.id);
          return ids.length > 0 ? sessionManager.dropTurnsByIds(ids).length : 0;
        },
        dropOldestSummaries: async count => {
          if (count <= 0) {
            return 0;
          }
          const ids = sessionManager
            .getSummaryTurns()
            .slice(0, count)
            .map(t => t.id);
          return ids.length > 0 ? sessionManager.dropTurnsByIds(ids).length : 0;
        },
      };
      registration.offer(capability);

      registration.registerSlashCommand({
        command: '/compact',
        description: 'Manage context compaction: show, drop, or force compact',
        handler: async (ctx: DroneSlashCommandContext) => {
          const sub = ctx.args[0]?.toLowerCase();

          switch (sub) {
            case 'show':
              return handleShow(capability, ctx);
            case 'drop':
              return handleDrop(capability, ctx, ctx.args.slice(1));
            case undefined:
            case '':
            case '--all':
              return handleCompact(capability, ctx, {
                all: ctx.args.includes('--all'),
              });
            default:
              ctx.logger.warn(`Unknown compact subcommand: ${sub}`);
              ctx.printHelp?.();
              return true;
          }
        },
      });

      registration.hooks.onPluginsLoaded(async () => {
        registration.logger.info(
          `compaction ready (strategy=${config.strategy}, threshold=${config.softThresholdPercent}%, slice=${config.slicePercent}%)`
        );
      });
    },
  };
}

/**
 * Pre-compaction flush (D4): describe any undescribed images in the turns
 * being compacted, writing descriptions back onto the stored image objects in
 * place (the turns are references into the session store, so mutation
 * persists). This ensures the summary — which may be produced by a non-vision
 * `summarizer` — sees the description text and captures its semantics, so
 * abstract context survives the compaction boundary even though image bytes
 * are destroyed. Idempotent (only undescribed images described). Fails open
 * (D9): a flush failure never blocks compaction.
 */
async function flushImageDescriptions(
  turns: DroneSessionTurn[],
  llm: DroneLlmCapability
): Promise<void> {
  const undescribed: DroneImageContent[] = [];
  for (const turn of turns) {
    for (const message of turn.messages) {
      for (const img of message.images ?? []) {
        if (!img.description) undescribed.push(img);
      }
    }
  }
  if (undescribed.length === 0) return;
  try {
    const described = await withTimeout(
      llm.describeImages(undescribed),
      60_000,
      'image description timed out'
    );
    for (let i = 0; i < undescribed.length; i++) {
      const desc = described[i]?.description;
      if (desc) undescribed[i].description = desc;
    }
  } catch {
    // Fail open: leave images undescribed; compaction proceeds.
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
