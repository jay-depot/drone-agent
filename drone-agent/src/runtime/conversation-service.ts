import {
  DroneLlmError,
  createDebugFlagRegistry,
  estimateTextTokens,
  parseModelSelection,
  resolveConfiguredReasoningLevel,
  type DroneGuardrailConfig,
  type DroneGuardrailThresholdConfig,
  type DebugFlagRegistry,
  type DroneChatRequest,
  type DroneChatResponse,
  type DroneReasoningLevel,
} from 'drone-core';
import type {
  DroneAgentConfig,
  DroneChatMessage,
  DroneConversationEvent,
  DroneImageContent,
  DroneLlmCapability,
  DroneLlmProvider,
  DroneLogger,
  DroneSessionSafetyTrimPayload,
  DroneToolCall,
  DroneToolDescriptor,
  DroneToolExecutionContext,
} from 'drone-core';
import {
  DEFAULT_RETRY_CONFIG,
  isContextWindowExceeded,
  withBoundedSilentRetry,
  type RetryPolicyConfig,
} from './llm-retry.js';
import { isRecord } from '../shared/type-guards.js';
import type { DronePluginEngine } from './plugin-engine.js';
import type { DroneSessionManager } from './session-manager.js';
import type { ContextBudgetService } from './context-budget-service.js';

export type ConversationEventHandler = (event: DroneConversationEvent) => void;
// Re-export for convenience — used by interactive.ts and tui/types.ts
export type { DroneConversationEvent as ConversationEvent } from 'drone-core';

/**
 * Sentinel value returned by `sendUserMessage` when the current request
 * is cancelled via `cancelCurrentRequest()`.
 */
export const CANCEL_SENTINEL = '__CANCELLED__';

export type ConversationService = {
  sendUserMessage: (
    prompt: string,
    onEvent?: ConversationEventHandler
  ) => Promise<string>;
  clearSession: () => void;
  getMessages: () => DroneChatMessage[];
  getEstimatedContextUsagePercent: () => Promise<number>;
  setModel: (newModel: string) => void;
  getModel: () => string;
  getReasoningLevel: () => DroneReasoningLevel | undefined;
  setReasoningLevel: (level: DroneReasoningLevel | undefined) => void;
  /**
   * Enqueue a user message to be processed when the current loop iteration
   * completes. Has no effect unless a `sendUserMessage` call is in flight.
   * When `sendUserMessage` returns, any remaining queued messages are
   * preserved and will be drained at the start of the next call.
   */
  enqueueUserMessage: (prompt: string) => void;
  /** Request soft cancellation of the current in-flight `sendUserMessage`. */
  cancelCurrentRequest: () => void;
  /** Get the list of currently enabled debug subsystems. */
  getDebugSubsystems: () => string[];
  /** Enable a debug subsystem by name (e.g. "llm"). */
  enableDebugSubsystem: (name: string) => void;
  /** Disable a debug subsystem by name (e.g. "llm"). */
  disableDebugSubsystem: (name: string) => void;
  /**
   * Reset the stuck-error and identical-tool-call streak detectors.
   * Used by the host to clear detectors after user intervention.
   */
  resetStuckDetectors: () => void;
};

type CreateConversationServiceOptions = {
  engine: DronePluginEngine;
  config: DroneAgentConfig;
  logger: DroneLogger;
  sessionManager: DroneSessionManager;
  debugFlags?: DebugFlagRegistry;
  budgetService: ContextBudgetService;
  maxToolIterations?: number;
  /**
   * Number of consecutive tool errors with the same (name, errorCode) before
   * the loop bails with a "model appears stuck" error. Defaults to 3.
   */
  stuckErrorThreshold?: number;
  /**
   * Optional callback invoked when the tool iteration limit is reached.
   * The host can prompt the user to continue. Return `true` to reset the
   * counter and keep going, or `false` to abort with the default error.
   * When omitted, the limit always produces a hard error.
   */
  onToolIterationLimitReached?: (
    currentCount: number,
    maxCount: number
  ) => Promise<boolean>;
  /**
   * Optional callback invoked when the stuck error threshold is reached
   * (same tool failing repeatedly). The host can prompt the user to continue.
   * Return `true` to reset the stuck counter and keep going, or `false` to
   * abort with the default error. When omitted, the threshold always produces
   * a hard error.
   */
  onStuckErrorThresholdReached?: (
    toolName: string,
    errorCode: string | null,
    failureCount: number
  ) => Promise<boolean>;
  /**
   * Optional callback invoked when the broken-response retry limit is
   * reached (empty or reasoning-only responses). The host can prompt the
   * user to continue. Return `true` to reset and continue, or `false`
   * to return an empty string. When omitted, the limit returns an empty
   * string.
   */
  onBrokenResponseLimitReached?: (
    type: 'empty' | 'reasoning-only'
  ) => Promise<boolean>;
  /**
   * Optional callback invoked when the identical tool-call streak limit
   * is reached. The host can prompt the user to continue. Return `true`
   * to reset the streak and continue, or `false` to abort. When omitted,
   * the limit always produces a hard error.
   */
  onIdenticalToolCallLimitReached?: (
    toolName: string,
    args: Record<string, unknown>,
    count: number
  ) => Promise<boolean>;
  /**
   * Optional callback invoked when an LLM chat() failure warrants prompting
   * the user to retry (Tier 2: non-transient HTTP statuses, or Tier 1
   * auto-retries exhausted). The host should present a terse yes/no question
   * (default no). Return `true` to retry, `false` to rethrow the underlying
   * error. When omitted, the conversation service fails fast (rethrows)
   * instead of prompting — this is the non-interactive behavior.
   */
  onRetryPrompt?: (error: DroneLlmError, attempt: number) => Promise<boolean>;
};

export function createConversationService({
  engine,
  config,
  logger,
  debugFlags = createDebugFlagRegistry(),
  sessionManager,
  budgetService,
  maxToolIterations,
  stuckErrorThreshold = 3,
  onToolIterationLimitReached,
  onStuckErrorThresholdReached,
  onBrokenResponseLimitReached,
  onIdenticalToolCallLimitReached,
  onRetryPrompt,
}: CreateConversationServiceOptions): ConversationService {
  let hasWarnedAboutSafetyTrim = false;
  let reasoningLevel: DroneReasoningLevel | undefined;

  // ── Guardrail config ───────────────────────────────────────────────────
  const guardrail: DroneGuardrailConfig = config.session.guardrail;

  // ── Retry policy ──────────────────────────────────────────────────────
  const retryConfig: RetryPolicyConfig = {
    maxRetries:
      config.session.retry?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
    maxWaitMs:
      config.session.retry?.maxWaitMs ?? DEFAULT_RETRY_CONFIG.maxWaitMs,
    promptOnError:
      config.session.retry?.promptOnError ?? DEFAULT_RETRY_CONFIG.promptOnError,
    backoffBaseMs:
      config.session.retry?.backoffBaseMs ?? DEFAULT_RETRY_CONFIG.backoffBaseMs,
    backoffFactor:
      config.session.retry?.backoffFactor ?? DEFAULT_RETRY_CONFIG.backoffFactor,
  };

  /** Fully-resolved threshold with no optional fields. */
  type ResolvedGuardrailThreshold = {
    hintAfter: number;
    maxHints: number;
  };

  const DEFAULT_GUARDRAIL: {
    brokenResponses: ResolvedGuardrailThreshold;
    reasoningOnlyResponses: ResolvedGuardrailThreshold;
    identicalToolCalls: ResolvedGuardrailThreshold;
  } = {
    brokenResponses: { hintAfter: 2, maxHints: 2 },
    reasoningOnlyResponses: { hintAfter: 4, maxHints: 2 },
    identicalToolCalls: { hintAfter: 2, maxHints: 3 },
  };

  /** Resolve a threshold config, filling in any missing field with its default
   * so callers never have to null-check optional schema fields. */
  function resolveThreshold(
    threshold: DroneGuardrailThresholdConfig | undefined,
    defaults: ResolvedGuardrailThreshold
  ): ResolvedGuardrailThreshold {
    return {
      hintAfter: threshold?.hintAfter ?? defaults.hintAfter,
      maxHints: threshold?.maxHints ?? defaults.maxHints,
    };
  }

  /** Fully-resolved guardrail thresholds, with defaults for any missing fields. */
  const resolvedGuardrail = {
    brokenResponses: resolveThreshold(
      guardrail.brokenResponses,
      DEFAULT_GUARDRAIL.brokenResponses
    ),
    reasoningOnlyResponses: resolveThreshold(
      guardrail.reasoningOnlyResponses,
      DEFAULT_GUARDRAIL.reasoningOnlyResponses
    ),
    identicalToolCalls: resolveThreshold(
      guardrail.identicalToolCalls,
      DEFAULT_GUARDRAIL.identicalToolCalls
    ),
  };

  // ── Streak / broken-response state (reset by resetStuckDetectors) ────
  let identicalToolCallStreak = 0;
  let lastIdenticalToolCall: {
    name: string;
    arguments: Record<string, unknown>;
  } | null = null;
  // Per-tier degenerate-response counters: truly-empty and reasoning-only use
  // independent thresholds, so they are counted separately (otherwise a model
  // alternating between the two could conflate their hintAfter/maxHints limits).
  let emptyResponseCount = 0;
  let reasoningOnlyResponseCount = 0;
  let stuckCount = 0;
  let identicalCallNudgeActive = false;
  let brokenResponseHintActive = false;

  // ── Message queue and cancel support ───────────────────────────────────
  const pendingMessages: string[] = [];
  let cancelled = false;

  function getLlmCapability(): DroneLlmCapability {
    const llm = engine.getCapability<DroneLlmCapability>('llm');
    if (!llm) {
      throw new Error('LLM provider broker is not available.');
    }
    return llm;
  }

  function resolveEffectiveMaxToolIterations(): number {
    // Check active persona's toolCallLimit first
    const personaCap = engine.getCapability<{
      getActivePersona: () => { toolCallLimit?: number } | null;
    }>('persona');
    const personaLimit = personaCap?.getActivePersona()?.toolCallLimit;
    if (personaLimit !== undefined && personaLimit > 0) {
      return personaLimit;
    }
    return maxToolIterations ?? config.session.maxToolIterations ?? 50;
  }

  function getCurrentModel(): string {
    return getLlmCapability().getModel();
  }

  /**
   * Get the list of tools visible to the LLM, filtered by the active
   * persona's `allowedTools` patterns (if any).
   */
  function getLlmTools(): DroneToolDescriptor[] {
    const allTools = engine.listTools();
    const personaCap = engine.getCapability<{
      getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
    }>('persona');
    return personaCap
      ? personaCap.getFilteredTools(allTools)
      : allTools.filter(t => !t.defaultHidden);
  }

  /**
   * Drain the pending message queue by appending each queued message as a
   * user turn in the session. Called at the top of the sendUserMessage loop
   * and at the start of a fresh sendUserMessage call.
   */
  function drainPendingMessages(): void {
    while (pendingMessages.length > 0) {
      const queued = pendingMessages.shift()!;
      sessionManager.appendUserMessage(queued);
      engine
        .runConversationEventHooks({
          kind: 'userMessage',
          content: queued,
        })
        .catch(err => {
          logger.warn(`Conversation event hook threw: ${err}`);
        });
    }
  }

  async function ensureSafeBudget(
    systemMessages: DroneChatMessage[],
    tools: ReturnType<DronePluginEngine['listTools']>
  ): Promise<void> {
    const contextWindow = await budgetService.resolveContextWindow();
    const currentModel = getCurrentModel();

    while (true) {
      const currentTurns = sessionManager.getTurns();
      const evaluation = budgetService.evaluateSafetyTrim({
        systemMessages,
        contextWindow,
        turns: currentTurns,
        tools,
      });

      if (evaluation === null) {
        throw new Error(
          `Session exceeds the safe context budget for ${currentModel}, and no conversational turns remain to drop. Use /clear to reset the session.`
        );
      }

      if (!evaluation.requiresTrim) {
        return;
      }

      const snapshot = budgetService.getBudgetSnapshot({
        systemMessages,
        contextWindow,
        turns: currentTurns,
        tools,
      });

      const payload: DroneSessionSafetyTrimPayload = {
        model: currentModel,
        contextWindow,
        budget: snapshot.budget,
        currentTurns,
        proposedDropTurnCount: evaluation.requiredDropTurnCount,
      };

      await engine.runSessionSafetyTrimWillRunHooks(payload);

      const turnsToDrop = Math.max(1, payload.proposedDropTurnCount);
      const droppedTurns =
        sessionManager.dropOldestNonSummaryTurns(turnsToDrop);
      if (droppedTurns.length === 0) {
        throw new Error(
          `Session exceeds the safe context budget for ${currentModel}, but no turns could be dropped. Use /clear to reset the session.`
        );
      }

      payload.droppedTurns = droppedTurns;
      payload.warningMessage =
        'Session context exceeded the safe budget; oldest turns were dropped. Use /clear to reset the session fully.';

      await engine.runSessionSafetyTrimAppliedHooks(payload);

      logger.warn(
        `Safety trim: dropping ${turnsToDrop} turn(s) to stay under budget ` +
          `(model=${currentModel}, ctx=${contextWindow.contextWindowTokens}, ` +
          `usage=${snapshot.budget.estimatedPromptTokens}/${contextWindow.contextWindowTokens})`
      );

      if (!hasWarnedAboutSafetyTrim) {
        logger.warn(payload.warningMessage);
        hasWarnedAboutSafetyTrim = true;
      }
    }
  }

  async function estimateCurrentContextUsagePercent(): Promise<number> {
    const systemMessages = await budgetService.buildSystemMessages();
    const contextWindow = await budgetService.resolveContextWindow();
    const tools = engine.listTools();
    const turns = sessionManager.getTurns();

    return budgetService.getEstimatedContextUsagePercent({
      systemMessages,
      contextWindow,
      turns,
      tools,
    });
  }

  /**
   * Truncate a tool result to a maximum token budget, appending a note
   * about the original size and guidance for retrieving the full output.
   */
  function truncateToolResult(content: string, maxTokens: number): string {
    if (maxTokens <= 0) return content;
    const estimatedTokens = estimateTextTokens(content);
    if (estimatedTokens <= maxTokens) return content;

    // Truncate to the character equivalent of the token limit
    const maxChars = maxTokens * 4;
    const truncated = content.slice(0, maxChars);
    return `${truncated}\n\n[Output truncated at ~${maxTokens} tokens. Full output was ~${estimatedTokens} tokens. For file__read and similar tools, request a smaller window. For exec__run, if you need the full output, consider piping the output of the command into a temp file and reading that.]`;
  }

  async function executeToolSafely(
    canonicalName: string,
    input: Record<string, unknown>,
    onProgress?: (chunk: string) => void,
    context?: DroneToolExecutionContext
  ): Promise<
    | { kind: 'ok'; content: string }
    | { kind: 'error'; content: string; code: string | null }
  > {
    try {
      const content = await engine.executeTool(
        canonicalName,
        input,
        onProgress,
        context
      );
      return { kind: 'ok', content };
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException)?.code ?? null;
      const message = code
        ? `${canonicalName} failed (${code}): ${rawMessage}`
        : `${canonicalName} failed: ${rawMessage}`;
      return { kind: 'error', content: message, code };
    }
  }

  return {
    sendUserMessage: async (prompt, onEvent) => {
      hasWarnedAboutSafetyTrim = false;

      // Drain any messages queued during or before this call
      // (e.g. from a previous cancelled request — preserve policy).
      drainPendingMessages();

      sessionManager.appendUserMessage(prompt);

      // A new user message resets the identical-tool-call streak and
      // the broken-response counter (this is a fresh turn).
      identicalToolCallStreak = 0;
      lastIdenticalToolCall = null;
      emptyResponseCount = 0;
      reasoningOnlyResponseCount = 0;
      identicalCallNudgeActive = false;
      brokenResponseHintActive = false;

      // Fire the user message event through the engine hook
      engine
        .runConversationEventHooks({
          kind: 'userMessage',
          content: prompt,
        })
        .catch(err => {
          logger.warn(`Conversation event hook threw: ${err}`);
        });

      const llm = getLlmCapability();
      let iterationCount = 0;
      let lastBudgetKey: string | undefined;
      let shouldStopLoop = false;

      const emit = (event: DroneConversationEvent): void => {
        if (onEvent) {
          try {
            onEvent(event);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`Conversation event handler threw: ${message}`);
          }
        }
        // Fire the engine hook (fire-and-forget so a slow/failing hook
        // doesn't block the conversation loop).
        engine.runConversationEventHooks(event).catch(err => {
          logger.warn(`Conversation event hook threw: ${err}`);
        });
      };

      /**
       * Run a chat() call with the unified error/retry classification:
       *   T1  bounded silent auto-retry on transient statuses (429/5xx),
       *       honoring Retry-After / exponential backoff, capped at
       *       `retryConfig.maxRetries` attempts.
       *   T2  prompt the user to retry (via onRetryPrompt) on other HTTP
       *       statuses or after T1 is exhausted — unless promptOnError is
       *       false or no callback is wired (non-interactive → fail fast).
       *   T3  fail fast on transport errors and context-window overflow.
       */
      async function runWithRetry(
        provider: DroneLlmProvider,
        request: DroneChatRequest
      ): Promise<DroneChatResponse> {
        let failureCount = 0;
        while (true) {
          try {
            return await withBoundedSilentRetry(
              async () => {
                try {
                  return await provider.chat(request);
                } catch (error) {
                  if (!(error instanceof DroneLlmError)) {
                    // T3: transport/network/bad-shape — not classifiable.
                    throw error;
                  }
                  // Context-window overflow → fail fast with guidance. This
                  // happens when compaction failed AND the token estimate
                  // undercounts the window; retrying would never succeed.
                  // Convert to a non-transient error so the shared helper
                  // throws it immediately (no auto-retry).
                  if (isContextWindowExceeded(error.status, error.message)) {
                    throw new DroneLlmError(error.message, {
                      status: error.status,
                      retryable: false,
                      retryAfterMs: error.retryAfterMs,
                      providerId: error.providerId,
                      body: error.body,
                    });
                  }
                  throw error;
                }
              },
              retryConfig,
              (llmErr, attempt, delay) => {
                failureCount = attempt;
                emit({
                  kind: 'notice',
                  content: `LLM API error (${llmErr.status ?? '?'}), retrying in ${Math.round(delay / 1000)}s (${attempt}/${retryConfig.maxRetries})`,
                });
              }
            );
          } catch (error) {
            if (!(error instanceof DroneLlmError)) {
              // T3: transport/network/bad-shape — not classifiable, throw.
              throw error;
            }
            const llmErr = error;

            // Context-window overflow → fail fast with guidance. This happens
            // when compaction failed AND the token estimate undercounts the
            // window; retrying would never succeed.
            if (isContextWindowExceeded(llmErr.status, llmErr.message)) {
              emit({
                kind: 'error',
                message: `LLM context window exceeded: ${llmErr.message}`,
              });
              throw new Error(
                'The LLM context window was exceeded, but compaction did not reclaim enough space (or the token estimate undercounts it). Enable compaction and run /compact to reset the session.'
              );
            }

            // T2: prompt the user to retry, or fail fast.
            emit({
              kind: 'error',
              message: `LLM request failed: ${llmErr.message}`,
            });
            if (retryConfig.promptOnError && onRetryPrompt) {
              const shouldRetry = await onRetryPrompt(llmErr, failureCount + 1);
              if (shouldRetry) {
                failureCount += 1;
                continue;
              }
            }
            throw llmErr;
          }
        }
      }

      // Shared tool-execution pipeline used by both the primary tool-call path
      // and the Feature-1 hint-recovery path: execute all tool calls in
      // parallel, truncate results, buffer them, emit batch/error events,
      // append results to the session, run onAfterToolCall hooks, and extract
      // images. Returns the buffered results plus stuck-detector info so the
      // caller can make its own loop decisions (iteration limit, stop, throw).
      async function executeToolCalls(toolCalls: DroneToolCall[]): Promise<{
        bufferedResults: Array<{
          name: string;
          content: string;
          toolCallId: string | undefined;
        }>;
        allErrors: boolean;
        firstErrorSignature: {
          name: string;
          code: string | null;
        } | null;
        allSameSignature: boolean;
      }> {
        // Execute all tool calls in parallel.
        const rawResults = await Promise.all(
          toolCalls.map(toolCall =>
            executeToolSafely(
              toolCall.name,
              toolCall.arguments,
              (chunk: string) => {
                emit({
                  kind: 'toolProgress',
                  name: toolCall.name,
                  content: chunk,
                });
              },
              {
                stopLoop: () => {
                  shouldStopLoop = true;
                },
              }
            ).then(toolResult => ({
              name: toolCall.name,
              toolResult,
              toolCallId: toolCall.id,
            }))
          )
        );

        // ── Tool result truncation ──────────────────────────────────────
        // Cap each successful tool result to a percentage of the context
        // window to prevent a single large result from consuming a
        // disproportionate share of the budget.
        const maxToolResultPct =
          config.session.maxToolResultTokensPercent ?? 15;
        if (maxToolResultPct > 0) {
          const ctxWindow = await budgetService.resolveContextWindow();
          const maxToolResultTokens = Math.max(
            1,
            Math.floor(ctxWindow.contextWindowTokens * (maxToolResultPct / 100))
          );
          for (const r of rawResults) {
            if (r.toolResult.kind === 'ok') {
              r.toolResult.content = truncateToolResult(
                r.toolResult.content,
                maxToolResultTokens
              );
            }
          }
        }

        // Collect results in order (the map preserves the array order).
        const bufferedResults: Array<{
          name: string;
          content: string;
          toolCallId: string | undefined;
        }> = [];
        for (const result of rawResults) {
          bufferedResults.push({
            name: result.name,
            content: result.toolResult.content,
            toolCallId: result.toolCallId,
          });
        }

        // Stuck detector: check all results. If all errors with the same
        // signature, increment stuckCount; otherwise reset. (Both callers
        // compute this harmlessly; only the primary path acts on it.)
        const allErrors = rawResults.every(r => r.toolResult.kind === 'error');
        const firstErrorSignature =
          allErrors && rawResults.length > 0
            ? {
                name: rawResults[0].name,
                code:
                  rawResults[0].toolResult.kind === 'error'
                    ? rawResults[0].toolResult.code
                    : null,
              }
            : null;
        const allSameSignature =
          allErrors &&
          firstErrorSignature !== null &&
          rawResults.every(
            r =>
              r.toolResult.kind === 'error' &&
              r.name === firstErrorSignature.name &&
              r.toolResult.code === firstErrorSignature.code
          );

        if (allSameSignature) {
          stuckCount += 1;
        } else {
          // Any successful tool call or mixed errors resets the stuck detector.
          stuckCount = 0;
        }

        // Emit the batch result so the TUI can commit all TailItems at once.
        emit({
          kind: 'toolResultBatch',
          results: rawResults.map(r => ({
            name: r.name,
            content: r.toolResult.content,
            arguments:
              toolCalls.find(tc => tc.id === r.toolCallId)?.arguments ?? {},
          })),
        });

        // Emit individual error events for any failed tool calls (for
        // non-TUI consumers that pattern-match on individual events).
        for (const result of rawResults) {
          if (result.toolResult.kind === 'error') {
            emit({ kind: 'error', message: result.toolResult.content });
          }
        }

        // Tool results are appended before onAfterToolCall hooks run, so that
        // hooks observe the full session state including the latest tool
        // results. This is critical for plugins like compaction, which need
        // an accurate view of context usage to decide whether to summarize.
        for (const result of bufferedResults) {
          sessionManager.appendToolResult(
            result.name,
            result.content,
            result.toolCallId
          );
        }

        try {
          await engine.runHooks('onAfterToolCall');
        } catch (hookError) {
          const msg =
            hookError instanceof Error ? hookError.message : String(hookError);
          logger.warn(`onAfterToolCall hook error (non-fatal): ${msg}`);
        }

        // After appending tool results, check for image data in tool results.
        // Per-tool structured extractors (D11) produce DroneImageContent[]
        // directly; unregistered tools fall back to the content-scan heuristic.
        // When the durability gate is on (log enabled or swarm active) we
        // eagerly describe images so the description lands in the persisted
        // store (D5). Otherwise we describe lazily at the request seam when a
        // non-vision model is about to receive the image (D3).
        const durabilityGate =
          config.log.enabled || engine.getCapability('swarm') !== undefined;
        for (const result of bufferedResults) {
          const images = extractImagesFromToolResult(result.name, result.content);
          if (images.length === 0) continue;
          const activeProvider = llm.getActiveProvider();
          if (activeProvider.supportsImagesInToolResults) {
            if (durabilityGate) {
              const described = await describeImagesSafely(llm, images);
              sessionManager.updateLastToolResultImages(described);
            } else {
              sessionManager.updateLastToolResultImages(images);
            }
          } else {
            const described = durabilityGate
              ? await describeImagesSafely(llm, images)
              : images;
            sessionManager.appendUserMessage(
              `[Image from ${result.name} tool]`,
              described
            );
          }
        }

        return {
          bufferedResults,
          allErrors,
          firstErrorSignature,
          allSameSignature,
        };
      }

      while (true) {
        const activeProviderId = llm.getActiveProviderId();
        const currentModel = llm.getModel();
        const budgetKey = `${activeProviderId}/${currentModel}`;
        if (budgetKey !== lastBudgetKey) {
          budgetService.resetContextWindowCache();
          lastBudgetKey = budgetKey;
        }

        // ── Soft cancel check ──
        if (cancelled) {
          cancelled = false;
          return CANCEL_SENTINEL;
        }

        // ── Drain queued messages ──
        drainPendingMessages();
        // Re-fetch tools each iteration so dynamic changes (MCP mount/unmount,
        // persona switches) are reflected immediately.
        const tools = getLlmTools();

        const systemMessages = await budgetService.buildSystemMessages();
        await ensureSafeBudget(systemMessages, tools);

        const provider = llm.getActiveProvider();

        // Resolve reasoning level: session override → selected model entry →
        // llm-level config (shared helper). Cross-wired legacy fallbacks to
        // inactive providers' sections are gone.
        const selection = parseModelSelection(
          `${activeProviderId}/${currentModel}`
        );
        const effectiveReasoningLevel =
          reasoningLevel ??
          (selection
            ? resolveConfiguredReasoningLevel(config, selection)
            : undefined);

        const targetHasVision =
          (await llm.hasVision?.(currentModel)) ?? false;
        const chatRequest: DroneChatRequest = {
          model: currentModel,
          messages: await (async () => {
            const base: DroneChatMessage[] = [
              ...systemMessages,
              ...sessionManager.getMessages(),
            ];
            if (identicalCallNudgeActive) {
              base.push({
                role: 'system',
                content:
                  'You appear to be stuck in a loop, making the same tool call repeatedly. Try a different approach, use different arguments, or explain why you cannot proceed differently.',
              });
            }
            if (brokenResponseHintActive) {
              base.push({
                role: 'system',
                content:
                  'Your last response was empty (no text and no tool calls). Please respond to the user. If you have nothing to say, provide a brief acknowledgment.',
              });
            }
            for (const reminder of engine.drainSystemReminders()) {
              base.push({ role: 'system', content: reminder });
            }
            // Lazy description (D3): when a non-vision model is about to
            // receive an undescribed image, describe it now (once-cached into
            // the stored message). Vision-capable targets skip generation.
            if (!targetHasVision) {
              await describeUndescribedImages(base, llm);
            }
            // Presentation stripping (D11): derive the wire representation
            // per target model. Vision-capable target → image via images[]
            // (base64 blob stripped from content, marker left). Non-vision
            // target → description substituted into content, image omitted.
            return prepareRequestMessages(base, targetHasVision);
          })(),
          tools,
          reasoningLevel: effectiveReasoningLevel,
          debug: debugFlags.isEnabled('llm'),
        };

        // ── Unified error/retry classification ─────────────────────────
        // T1  bounded silent auto-retry on transient statuses (429/5xx),
        //     honoring Retry-After / exponential backoff.
        // T2  prompt the user to retry on other HTTP statuses (auth too)
        //     after T1 is exhausted.
        // T3  fail fast on transport errors and context-window overflow.
        const response = await runWithRetry(provider, chatRequest);

        const toolCalls = response.toolCalls ?? [];
        const assistantText = response.message ?? '';
        const isBrokenResponse =
          toolCalls.length === 0 && assistantText.length === 0;
        const isReasoningOnlyResponse =
          toolCalls.length === 0 &&
          assistantText.length === 0 &&
          (response.reasoning?.length ?? 0) > 0;

        // ── Feature 1: Broken response detection & retry ──────────────
        // A degenerate response has no tool calls and no assistant message.
        // Truly-empty: no reasoning either. Reasoning-only: has reasoning text
        // but nothing else. We retry with progressively stronger hints rather
        // than polluting the session with useless turns.
        if (isBrokenResponse) {
          const tier: ResolvedGuardrailThreshold = isReasoningOnlyResponse
            ? resolvedGuardrail.reasoningOnlyResponses
            : resolvedGuardrail.brokenResponses;
          const label = isReasoningOnlyResponse ? 'reasoning-only' : 'empty';
          const tierCount = isReasoningOnlyResponse
            ? ++reasoningOnlyResponseCount
            : ++emptyResponseCount;

          if (tierCount <= tier.hintAfter) {
            // Phase 1: retry with identical context (no hint, no session mutation)
            emit({
              kind: 'notice',
              content: `Degenerate response (${label}), retrying (${tierCount}/${tier.hintAfter})`,
            });
            continue;
          }

          if (tierCount < tier.hintAfter + tier.maxHints) {
            // Phase 2: set the hint flag so the next iteration injects a
            // non-persisted system hint (mirrors the identical-call nudge).
            emit({
              kind: 'notice',
              content: `Degenerate response (${label}), retrying with hint (${tierCount - tier.hintAfter}/${tier.maxHints})`,
            });
            brokenResponseHintActive = true;
            continue;
          }

          // Hard limit reached
          emit({
            kind: 'notice',
            content: `Degenerate response (${label}) retry limit reached after ${tierCount} attempts.`,
          });
          if (onBrokenResponseLimitReached) {
            const shouldContinue = await onBrokenResponseLimitReached(label);
            if (shouldContinue) {
              if (isReasoningOnlyResponse) {
                reasoningOnlyResponseCount = 0;
              } else {
                emptyResponseCount = 0;
              }
              brokenResponseHintActive = false;
              continue;
            }
          }
          return '';
        }

        // ── Non-broken response: reset broken-response counter ───────
        emptyResponseCount = 0;
        reasoningOnlyResponseCount = 0;
        brokenResponseHintActive = false;

        // Reasoning is only emitted for KEPT responses.
        if (response.reasoning && response.reasoning.length > 0) {
          emit({ kind: 'reasoning', content: response.reasoning });
          emit({ kind: 'reasoningComplete' });
        }

        // Iteration-limit check for tool-call rounds. Runs before the
        // assistant append so a limit hit doesn't leave a dangling turn.
        if (toolCalls.length > 0) {
          // ── Feature 3: emit assistant text before tool call batch ──
          if (assistantText.length > 0) {
            emit({ kind: 'assistantMessage', content: assistantText });
            emit({ kind: 'assistantMessageComplete' });
          }

          // ── Feature 2: identical tool-call streak detection ────────
          if (toolCalls.length === 1) {
            const call = toolCalls[0];
            if (
              lastIdenticalToolCall &&
              lastIdenticalToolCall.name === call.name &&
              JSON.stringify(lastIdenticalToolCall.arguments) ===
                JSON.stringify(call.arguments)
            ) {
              identicalToolCallStreak += 1;
            } else {
              identicalToolCallStreak = 1;
            }
            lastIdenticalToolCall = {
              name: call.name,
              arguments: call.arguments,
            };
          } else {
            identicalToolCallStreak = 0;
            lastIdenticalToolCall = null;
          }

          // Check identical tool-call nudge/limit thresholds
          const itcConfig = resolvedGuardrail.identicalToolCalls;
          // Reset nudge flag — it will be set again if the streak persists
          identicalCallNudgeActive = false;
          if (
            identicalToolCallStreak > itcConfig.hintAfter &&
            identicalToolCallStreak <= itcConfig.hintAfter + itcConfig.maxHints
          ) {
            emit({
              kind: 'notice',
              content: `Detected repeated identical tool call (${lastIdenticalToolCall?.name}), injecting nudge.`,
            });
            // Inject a non-persisted system nudge on the next LLM call.
            identicalCallNudgeActive = true;
          }

          // Iteration-limit check runs BEFORE the identical-call hard limit
          // so a repeated tool call that also exceeds the configured session
          // depth trips the depth limit (which the host can prompt on) rather
          // than the "model appears stuck" abort.
          iterationCount += 1;
          const effectiveMax = resolveEffectiveMaxToolIterations();
          if (iterationCount > effectiveMax) {
            if (onToolIterationLimitReached) {
              const shouldContinue = await onToolIterationLimitReached(
                iterationCount,
                effectiveMax
              );
              if (shouldContinue) {
                iterationCount = 0;
                // A fresh run — reset the identical-call streak too so the
                // same tool call after a user-acknowledged continue doesn't
                // immediately hit the identical-call limit.
                identicalToolCallStreak = 0;
                lastIdenticalToolCall = null;
                identicalCallNudgeActive = false;
                continue;
              }
            }
            throw new Error(
              `Tool call depth exceeded the configured session limit of ${effectiveMax}. ` +
                'Use /clear to reset the session, or raise session.maxToolIterations in your config.'
            );
          }

          if (
            identicalToolCallStreak >
            itcConfig.hintAfter + itcConfig.maxHints
          ) {
            // Hard limit reached
            if (onIdenticalToolCallLimitReached) {
              const shouldContinue = await onIdenticalToolCallLimitReached(
                lastIdenticalToolCall!.name,
                lastIdenticalToolCall!.arguments,
                identicalToolCallStreak
              );
              if (shouldContinue) {
                identicalToolCallStreak = 0;
                // Continue processing this tool call normally
              }
            } else {
              throw new Error(
                `Model appears stuck: repeated identical call to ${lastIdenticalToolCall?.name} ` +
                  `${identicalToolCallStreak} times. Aborting.`
              );
            }
          }
        }

        // Every assistant message is its own turn.
        sessionManager.appendAssistantMessage(
          response.message ?? '',
          toolCalls.length > 0 ? toolCalls : undefined
        );

        if (toolCalls.length > 0) {
          // Emit the batch start so the TUI can create one TailItem per tool call.
          emit({
            kind: 'toolCallBatch',
            toolCalls: toolCalls.map(tc => ({
              name: tc.name,
              arguments: tc.arguments,
            })),
          });

          // Execute all tool calls through the shared pipeline.
          const { firstErrorSignature, allSameSignature, allErrors } =
            await executeToolCalls(toolCalls);

          if (
            firstErrorSignature &&
            allSameSignature &&
            stuckCount >= stuckErrorThreshold &&
            allErrors
          ) {
            const codeSuffix = firstErrorSignature.code
              ? ` (${firstErrorSignature.code})`
              : '';
            if (onStuckErrorThresholdReached) {
              const shouldContinue = await onStuckErrorThresholdReached(
                firstErrorSignature.name,
                firstErrorSignature.code,
                stuckCount
              );
              if (shouldContinue) {
                // Reset the stuck detector and continue.
                stuckCount = 0;
                continue;
              }
            }
            throw new Error(
              `Model appears stuck on ${firstErrorSignature.name}${codeSuffix}: ` +
                `failed ${stuckCount} times in a row. Aborting. ` +
                'Use /clear to reset the session, or refine the prompt to give the model more context (e.g. the correct path or arguments).'
            );
          }

          // If a tool signaled the loop to stop (e.g. subagent__return),
          // exit the conversation loop now instead of continuing to the LLM.
          if (shouldStopLoop) {
            return response.message ?? '';
          }

          continue;
        }

        // No tool calls — this is the final assistant reply (already appended
        // above as its own turn).
        const assistantMessage = response.message ?? '';
        if (assistantMessage.length > 0) {
          emit({ kind: 'assistantMessage', content: assistantMessage });
          emit({ kind: 'assistantMessageComplete' });
        }
        return assistantMessage;
      }
    },
    clearSession: () => {
      hasWarnedAboutSafetyTrim = false;
      pendingMessages.length = 0;
      cancelled = false;
      stuckCount = 0;
      identicalToolCallStreak = 0;
      lastIdenticalToolCall = null;
      emptyResponseCount = 0;
      reasoningOnlyResponseCount = 0;
      identicalCallNudgeActive = false;
      brokenResponseHintActive = false;
      engine.clearSystemReminders();
      sessionManager.clearSession();
    },
    getMessages: () => sessionManager.getMessages(),
    getEstimatedContextUsagePercent: () => estimateCurrentContextUsagePercent(),
    setModel: (newModel: string) => {
      // Accept canonical full-form selections (<provider>/<model>) by
      // switching providers when needed; bare ids set within the active
      // provider as before.
      const llm = getLlmCapability();
      if (newModel.includes('/')) {
        const selection = parseModelSelection(newModel);
        if (selection) {
          if (selection.providerId !== llm.getActiveProviderId()) {
            llm.activateProvider(selection.providerId);
          }
          llm.setModel(selection.modelLocalId);
          return;
        }
      }
      llm.setModel(newModel);
      budgetService.resetContextWindowCache();
    },
    getModel: () => getLlmCapability().getModel(),
    getReasoningLevel: () => reasoningLevel,
    setReasoningLevel: (level: DroneReasoningLevel | undefined) => {
      reasoningLevel = level;
    },
    enqueueUserMessage: (prompt: string) => {
      pendingMessages.push(prompt);
    },
    cancelCurrentRequest: () => {
      cancelled = true;
    },
    resetStuckDetectors: () => {
      stuckCount = 0;
      identicalToolCallStreak = 0;
      lastIdenticalToolCall = null;
      emptyResponseCount = 0;
      reasoningOnlyResponseCount = 0;
      identicalCallNudgeActive = false;
      brokenResponseHintActive = false;
    },
    getDebugSubsystems: () => debugFlags.list(),
    enableDebugSubsystem: (name: string) => {
      debugFlags.enable(name);
    },
    disableDebugSubsystem: (name: string) => {
      debugFlags.disable(name);
    },
  };
}

// ── Per-tool image extractor registry (D11) ─────────────────────────────
// Tools that know their own return shape register a structured extractor
// producing DroneImageContent[] directly. Unregistered tools fall back to the
// content-scan heuristic (extractImageFromToolResult / findDataUri).
type ImageExtractor = (content: string) => DroneImageContent[];

const imageExtractors = new Map<string, ImageExtractor>();

/** Register a structured image extractor for a tool name. */
export function registerImageExtractor(
  toolName: string,
  extractor: ImageExtractor
): void {
  imageExtractors.set(toolName, extractor);
}

/** Extract images from a tool result, using the structured extractor when registered. */
function extractImagesFromToolResult(
  toolName: string,
  content: string
): DroneImageContent[] {
  const structured = imageExtractors.get(toolName);
  if (structured) {
    try {
      const images = structured(content);
      if (images.length > 0) return images;
    } catch {
      // Fall through to the heuristic on malformed structured output.
    }
  }
  const single = extractImageFromToolResult(content);
  return single ? [single] : [];
}

// file__read_image returns JSON `{ path, mimeType, data, size }`.
registerImageExtractor('file__read_image', content => {
  const parsed = JSON.parse(content);
  if (
    isRecord(parsed) &&
    typeof parsed.mimeType === 'string' &&
    parsed.mimeType.startsWith('image/') &&
    typeof parsed.data === 'string'
  ) {
    return [{ mimeType: parsed.mimeType, data: parsed.data }];
  }
  return [];
});

/**
 * Describe images via the broker's describeImages capability, guarded by a
 * ~60s timeout (aligned with retry maxWaitMs). Fails open: on timeout or
 * describer failure, images are returned unchanged (idempotent — a later
 * call can retry). Never hard-errors on describer failure (D9).
 */
async function describeImagesSafely(
  llm: DroneLlmCapability,
  images: DroneImageContent[]
): Promise<DroneImageContent[]> {
  try {
    return await withTimeout(
      llm.describeImages(images),
      60_000,
      'image description timed out'
    );
  } catch {
    // Fail open: return images unchanged. The broker already warns on
    // describer failure; this guard covers the timeout path.
    return images;
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

/**
 * Describe any undescribed images across the given messages, writing the
 * descriptions back onto the stored image objects in place (the messages are
 * references into the session store, so mutation persists). Idempotent —
 * already-described images are skipped. Fails open (D9).
 */
async function describeUndescribedImages(
  messages: DroneChatMessage[],
  llm: DroneLlmCapability
): Promise<void> {
  const undescribed: DroneImageContent[] = [];
  for (const message of messages) {
    for (const img of message.images ?? []) {
      if (!img.description) undescribed.push(img);
    }
  }
  if (undescribed.length === 0) return;
  const described = await describeImagesSafely(llm, undescribed);
  // Write descriptions back onto the original image objects in place.
  for (let i = 0; i < undescribed.length; i++) {
    const desc = described[i]?.description;
    if (desc) undescribed[i].description = desc;
  }
}

function extractImageFromToolResult(content: string): DroneImageContent | null {
  try {
    const parsed = JSON.parse(content);
    if (isRecord(parsed)) {
      // Check for file__read_image format
      if (
        typeof parsed.mimeType === 'string' &&
        parsed.mimeType.startsWith('image/') &&
        typeof parsed.data === 'string'
      ) {
        return { mimeType: parsed.mimeType, data: parsed.data };
      }
      // Check for MCP data URI in any string field
      const dataUri = findDataUri(parsed);
      if (dataUri) return dataUri;
    }
  } catch {
    // Not JSON — skip
  }
  return null;
}

function findDataUri(obj: unknown): DroneImageContent | null {
  if (typeof obj === 'string') {
    const match = obj.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) return { mimeType: match[1], data: match[2] };
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const result = findDataUri(item);
      if (result) return result;
    }
  }
  if (isRecord(obj)) {
    for (const val of Object.values(obj)) {
      const result = findDataUri(val);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Derive the wire representation of each message for the target model (D11).
 * - Vision-capable target: image carried via `images[]`; the redundant base64
 *   blob is stripped from the content string, leaving a marker.
 * - Non-vision target: the image is omitted and its description (if present)
 *   is substituted into the content; if no description exists, the image is
 *   sent as-is (today's behavior — fail open).
 * Storage/estimator are untouched; this is presentation-only.
 */
function prepareRequestMessages(
  messages: DroneChatMessage[],
  targetHasVision: boolean
): DroneChatMessage[] {
  return messages.map(message => {
    if (!message.images || message.images.length === 0) {
      return message;
    }
    if (targetHasVision) {
      // Strip the base64 blob from content, leaving a marker. The image is
      // carried via images[].
      const stripped = stripBase64Blobs(message.content);
      return stripped === message.content
        ? message
        : { ...message, content: stripped };
    }
    // Non-vision target: substitute descriptions into content, omit images.
    const described = message.images.filter(img => img.description);
    if (described.length === 0) {
      // No descriptions available — send as-is (fail open).
      return message;
    }
    const descriptionText = described
      .map(img => img.description)
      .join('\n');
    const content = message.content
      ? `${message.content}\n\n[Image description]\n${descriptionText}`
      : `[Image description]\n${descriptionText}`;
    return { ...message, content, images: undefined };
  });
}

/** Strip base64 image blobs from a content string, leaving a marker. */
function stripBase64Blobs(content: string): string {
  return content.replace(
    /data:image\/\w+;base64,[A-Za-z0-9+/=]+/g,
    '[Image attached]'
  );
}
