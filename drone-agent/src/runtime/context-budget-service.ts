import {
  estimateSessionBudget,
  type DroneAgentConfig,
  type DroneChatMessage,
  type DroneContextWindowInfo,
  type DroneLlmProvider,
  type DroneSessionTurn,
  type DroneTokenEstimate,
  type DroneToolDescriptor,
} from 'drone-core';

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
 * - Build system messages from config + rendered prompt fragments
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
   * Build the current system messages (config prompt + rendered fragments).
   */
  buildSystemMessages: () => Promise<DroneChatMessage[]>;

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
  getProvider: () => DroneLlmProvider;
  getModel: () => string;
};

export function createContextBudgetService({
  config,
  renderPromptFragments,
  getProvider,
  getModel,
}: CreateContextBudgetServiceOptions): ContextBudgetService {
  let contextWindowInfoPromise: Promise<DroneContextWindowInfo> | undefined;

  async function buildSystemMessages(): Promise<DroneChatMessage[]> {
    const base: DroneChatMessage[] = [
      { role: 'system', content: config.systemPrompt },
    ];
    const fragments = await renderPromptFragments();
    for (const content of fragments) {
      base.push({ role: 'system', content } satisfies DroneChatMessage);
    }
    return base;
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

    const ratio = budget.estimatedPromptTokens / input.contextWindow.contextWindowTokens;
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

    // Compute the minimum number of oldest non-summary turns to drop.
    for (let dropCount = 1; dropCount <= input.turns.length; dropCount += 1) {
      const candidateBudget = estimateSessionBudget({
        systemMessages: input.systemMessages,
        turns: input.turns.slice(dropCount),
        tools: input.tools,
        sessionConfig: config.session,
        contextWindowTokens: input.contextWindow.contextWindowTokens,
      });

      if (!candidateBudget.requiresSafetyTrim) {
        return {
          requiresTrim: true,
          requiredDropTurnCount: dropCount,
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
    resolveContextWindow,
    resetContextWindowCache: () => {
      contextWindowInfoPromise = undefined;
    },
    getBudgetSnapshot,
    evaluateSafetyTrim,
    getEstimatedContextUsagePercent,
  };
}
