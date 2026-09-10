import {
  estimateSessionBudget,
  type RuntimeFlagRegistry,
  type DroneAgentConfig,
  type DroneChatMessage,
  type DroneContextWindowInfo,
  type DroneLlmProvider,
  type DroneSessionTurn,
  type DroneTokenEstimate,
  type DroneToolDescriptor,
} from 'drone-core';
import { getOldestNonSummaryTurns } from './turn-utils.js';

/**
 * A snapshot of the current context budget, including system messages,
 * context window info, and the estimated token budget.
 */
export type BudgetSnapshot = {
  /** Fully resolved system messages (config prompt + rendered fragments). */
  systemMessages: DroneChatMessage[];
  /** Context window info (probed from provider or fallback). */
  contextWindow: DroneContextWindowInfo;
  /** Estimated token budget for the current session state. */
  budget: DroneTokenEstimate;
  /** Usage as a percentage of the context window (0-100). */
  usagePercent: number;
};

/**
 * The result of evaluating whether safety trimming is needed.
 */
export type SafetyTrimEvaluation =
  | {
      requiresTrim: true;
      /** Minimum number of oldest non-summary turns to drop to get under budget. */
      requiredDropTurnCount: number;
    }
  | {
      requiresTrim: false;
    };

/**
 * Narrow service that centralizes context-window budgeting.
 *
 * Responsibilities:
 * - Build header system messages from config + runtime flags + rendered header fragments
 * - Build footer system messages from rendered footer fragments
 * - Resolve context-window info from the LLM provider
 * - Estimate token budgets using `estimateSessionBudget`
 * - Decide whether safety trimming is needed and compute the minimum drop count
 *
 * Non-responsibilities (owned by callers or plugins):
 * - Dropping or mutating session turns
 * - Firing safety-trim hooks
 * - Compacting or summarizing turns
 * - Logging or writing to memory
 */
export type ContextBudgetService = {
  /**
   * Build the current header system messages.
   */
  buildSystemMessages: () => Promise<DroneChatMessage[]>;

  /**
   * Build footer system messages from rendered footer fragments.
   */
  buildFooterMessages: () => Promise<DroneChatMessage[]>;

  /**
   * Resolve context-window info, probing the provider or falling back to config.
   */
  resolveContextWindow: () => Promise<DroneContextWindowInfo>;

  /**
   * Reset the cached context-window info so the next call to
   * `resolveContextWindow` re-probes the provider. Call this when
   * the model changes.
   */
  resetContextWindowCache: () => void;

  /**
   * Get a full budget snapshot for the current session state.
   */
  getBudgetSnapshot: (input: {
    systemMessages: DroneChatMessage[];
    contextWindow: DroneContextWindowInfo;
    turns: DroneSessionTurn[];
    tools: DroneToolDescriptor[];
  }) => BudgetSnapshot;

  /**
   * Evaluate whether safety trimming is needed and, if so, how many
   * oldest non-summary turns must be dropped to get under budget.
   *
   * Returns `{ requiresTrim: false }` when the budget is safe.
   * Returns `{ requiresTrim: true, requiredDropTurnCount }` when trimming
   * is needed, or `null` when trimming is needed but no number of drops
   * would suffice (all turns would need to be dropped).
   */
  evaluateSafetyTrim: (input: {
    systemMessages: DroneChatMessage[];
    contextWindow: DroneContextWindowInfo;
    turns: DroneSessionTurn[];
    tools: DroneToolDescriptor[];
  }) => SafetyTrimEvaluation | null;

  /**
   * Convenience: estimate the current context usage as a percentage (0-100).
   */
  getEstimatedContextUsagePercent: (input: {
    systemMessages: DroneChatMessage[];
    contextWindow: DroneContextWindowInfo;
    turns: DroneSessionTurn[];
    tools: DroneToolDescriptor[];
  }) => number;
};

type CreateContextBudgetServiceOptions = {
  config: DroneAgentConfig;
  /**
   * Lazy getter for rendering prompt fragments. Called each time
   * `buildSystemMessages` is invoked. Accepts a function that may
   * resolve the engine later (to break circular init dependencies).
   */
  renderPromptFragments: () => Promise<string[]>;
  /**
   * Optional phase-aware fragment renderer. When provided, header/footer
   * prompts are rendered separately; otherwise `renderPromptFragments` is
   * used for backward-compatible header assembly and footer remains empty.
   */
  renderPromptFragmentsByPhase?: (
    phase: 'header' | 'footer'
  ) => Promise<string[]>;
  getProvider: () => DroneLlmProvider;
  getModel: () => string;
  /**
   * Lazy getter for the runtime flag registry. When provided, its rendered
   * content is injected into the system messages between the config system
   * prompt and plugin prompt fragments.
   */
  runtimeFlags?: () => RuntimeFlagRegistry;
};

export function createContextBudgetService({
  config,
  renderPromptFragments,
  renderPromptFragmentsByPhase,
  getProvider,
  getModel,
  runtimeFlags,
}: CreateContextBudgetServiceOptions): ContextBudgetService {
  let contextWindowInfoPromise: Promise<DroneContextWindowInfo> | undefined;
  async function buildSystemMessages(): Promise<DroneChatMessage[]> {
    const base: DroneChatMessage[] = [
      { role: 'system', content: config.systemPrompt },
    ];
    const flagsContent = runtimeFlags?.()?.render();
    if (flagsContent) {
      base.push({
        role: 'system',
        content: flagsContent,
      } satisfies DroneChatMessage);
    }
    const fragments = renderPromptFragmentsByPhase
      ? await renderPromptFragmentsByPhase('header')
      : await renderPromptFragments();
    for (const content of fragments) {
      base.push({ role: 'system', content } satisfies DroneChatMessage);
    }
    return base;
  }

  async function buildFooterMessages(): Promise<DroneChatMessage[]> {
    if (!renderPromptFragmentsByPhase) {
      return [];
    }
    const fragments = await renderPromptFragmentsByPhase('footer');
    if (fragments.length === 0) {
      return [];
    }
    // Merge all footer fragments into a single trailing system message.
    // A run of consecutive trailing system messages after the conversation
    // turns is an untrained shape for some chat templates (GLM-5.3-flash
    // intermittently ended rounds with narration and no tool call after
    // PR #99 moved fragments to the footer). A single trailing system
    // message is a proven-safe shape (nudges landed there pre-#99). Topic
    // delineation is preserved because every fragment starts with a
    // top-level `# Heading` per the project's fragment convention.
    return [
      {
        role: 'system',
        content: fragments.join('\n\n'),
      },
    ];
  }

  async function resolveContextWindow(): Promise<DroneContextWindowInfo> {
    contextWindowInfoPromise ??= (async () => {
      const provider = getProvider();
      const probed = await provider.getContextWindowInfo?.({
        model: getModel(),
      });
      if (probed) {
        return probed;
      }

      return {
        model: getModel(),
        contextWindowTokens: config.session.contextWindowTokens,
        source: 'config',
      };
    })();

    return contextWindowInfoPromise;
  }

  function getBudgetSnapshot(input: {
    systemMessages: DroneChatMessage[];
    contextWindow: DroneContextWindowInfo;
    turns: DroneSessionTurn[];
    tools: DroneToolDescriptor[];
  }): BudgetSnapshot {
    const budget = estimateSessionBudget({
      systemMessages: input.systemMessages,
      turns: input.turns,
      tools: input.tools,
      sessionConfig: config.session,
      contextWindowTokens: input.contextWindow.contextWindowTokens,
    });

    const ratio =
      budget.estimatedPromptTokens / input.contextWindow.contextWindowTokens;
    const rawPercent = Math.round(ratio * 100);
    const usagePercent = Math.min(
      Number.isFinite(rawPercent) && rawPercent >= 0 ? rawPercent : 0,
      100
    );

    return {
      systemMessages: input.systemMessages,
      contextWindow: input.contextWindow,
      budget,
      usagePercent,
    };
  }

  function evaluateSafetyTrim(input: {
    systemMessages: DroneChatMessage[];
    contextWindow: DroneContextWindowInfo;
    turns: DroneSessionTurn[];
    tools: DroneToolDescriptor[];
  }): SafetyTrimEvaluation | null {
    const { budget } = getBudgetSnapshot(input);

    if (!budget.requiresSafetyTrim) {
      return { requiresTrim: false };
    }

    // Compute the minimum number of oldest non-summary turns to drop,
    // mirroring dropOldestNonSummaryTurns semantics (skip summary turns).
    for (let dropCount = 1; dropCount <= input.turns.length; dropCount += 1) {
      const droppable = getOldestNonSummaryTurns(input.turns, dropCount);
      if (droppable.length < dropCount) {
        // No more non-summary turns to drop.
        break;
      }

      const droppableIds = new Set(droppable.map(turn => turn.id));
      const candidateBudget = estimateSessionBudget({
        systemMessages: input.systemMessages,
        turns: input.turns.filter(turn => !droppableIds.has(turn.id)),
        tools: input.tools,
        sessionConfig: config.session,
        contextWindowTokens: input.contextWindow.contextWindowTokens,
      });

      if (!candidateBudget.requiresSafetyTrim) {
        return {
          requiresTrim: true,
          requiredDropTurnCount: droppable.length,
        };
      }
    }

    // No number of drops would suffice.
    return null;
  }

  function getEstimatedContextUsagePercent(input: {
    systemMessages: DroneChatMessage[];
    contextWindow: DroneContextWindowInfo;
    turns: DroneSessionTurn[];
    tools: DroneToolDescriptor[];
  }): number {
    const { usagePercent } = getBudgetSnapshot(input);
    return usagePercent;
  }

  return {
    buildSystemMessages,
    buildFooterMessages,
    resolveContextWindow,
    resetContextWindowCache: () => {
      contextWindowInfoPromise = undefined;
    },
    getBudgetSnapshot,
    evaluateSafetyTrim,
    getEstimatedContextUsagePercent,
  };
}
