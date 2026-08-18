import {
  createDebugFlagRegistry,
  estimateTextTokens,
  type DebugFlagRegistry,
  type DroneReasoningLevel,
} from 'drone-core';
import type {
  DroneAgentConfig,
  DroneChatMessage,
  DroneConversationEvent,
  DroneImageContent,
  DroneLlmCapability,
  DroneLogger,
  DroneSessionSafetyTrimPayload,
  DroneToolDescriptor,
  DroneToolExecutionContext,
} from 'drone-core';
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
}: CreateConversationServiceOptions): ConversationService {
  let hasWarnedAboutSafetyTrim = false;
  let reasoningLevel: DroneReasoningLevel | undefined;

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
      let stuckCount = 0;
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

      while (true) {
        const activeProviderId = llm.getActiveProviderId();
        const currentModel = llm.getModel();
        const budgetKey = `${activeProviderId}:${currentModel}`;
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

        // Resolve reasoning level: session override → config → undefined
        const effectiveReasoningLevel =
          reasoningLevel ??
          config.llm.reasoningLevel ??
          config.ollama.reasoningLevel ??
          config.openrouter.reasoningLevel;

        const response = await provider.chat({
          model: currentModel,
          messages: [...systemMessages, ...sessionManager.getMessages()],
          tools,
          reasoningLevel: effectiveReasoningLevel,
          debug: debugFlags.isEnabled('llm'),
        });

        if (response.reasoning && response.reasoning.length > 0) {
          emit({ kind: 'reasoning', content: response.reasoning });
          emit({ kind: 'reasoningComplete' });
        }

        const toolCalls = response.toolCalls ?? [];

        // Iteration-limit check for tool-call rounds. Runs before the
        // assistant append so a limit hit doesn't leave a dangling turn.
        if (toolCalls.length > 0) {
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
                continue;
              }
            }
            throw new Error(
              `Tool call depth exceeded the configured session limit of ${effectiveMax}. ` +
                'Use /clear to reset the session, or raise session.maxToolIterations in your config.'
            );
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
              Math.floor(
                ctxWindow.contextWindowTokens * (maxToolResultPct / 100)
              )
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

          // Stuck detector: check all results. If all errors with the same
          // signature, increment stuckCount; otherwise reset.
          const allErrors = rawResults.every(
            r => r.toolResult.kind === 'error'
          );
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

          for (const result of rawResults) {
            bufferedResults.push({
              name: result.name,
              content: result.toolResult.content,
              toolCallId: result.toolCallId,
            });
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
              hookError instanceof Error
                ? hookError.message
                : String(hookError);
            logger.warn(`onAfterToolCall hook error (non-fatal): ${msg}`);
          }

          // After appending tool results, check for image data in tool results
          for (const result of bufferedResults) {
            const imageContent = extractImageFromToolResult(result.content);
            if (imageContent) {
              const provider = llm.getActiveProvider();
              if (provider.supportsImagesInToolResults) {
                // Anthropic: update the tool result message to include images inline
                sessionManager.updateLastToolResultImages([imageContent]);
              } else {
                // OpenAI/OpenRouter/Ollama: inject synthetic user message
                sessionManager.appendUserMessage(
                  `[Image from ${result.name} tool]`,
                  [imageContent]
                );
              }
            }
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
      sessionManager.clearSession();
    },
    getMessages: () => sessionManager.getMessages(),
    getEstimatedContextUsagePercent: () => estimateCurrentContextUsagePercent(),
    setModel: (newModel: string) => {
      getLlmCapability().setModel(newModel);
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
    getDebugSubsystems: () => debugFlags.list(),
    enableDebugSubsystem: (name: string) => {
      debugFlags.enable(name);
    },
    disableDebugSubsystem: (name: string) => {
      debugFlags.disable(name);
    },
  };
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
