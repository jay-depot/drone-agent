import type {
  DroneAgentConfig,
  DroneChatMessage,
  DroneLlmCapability,
  DroneLogger,
  DroneSessionSafetyTrimPayload,
  DroneToolDescriptor,
} from 'drone-core';
import type { DronePluginEngine } from './plugin-engine.js';
import type { DroneSessionManager } from './session-manager.js';
import type { ContextBudgetService } from './context-budget-service.js';

export type ConversationEvent =
  | { kind: 'reasoning'; content: string }
  | { kind: 'assistantMessage'; content: string }
  | { kind: 'toolCall'; name: string; arguments: Record<string, unknown> }
  | {
      kind: 'toolResult';
      name: string;
      content: string;
      arguments: Record<string, unknown>;
    }
  | { kind: 'error'; message: string };

export type ConversationEventHandler = (event: ConversationEvent) => void;

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
};

type CreateConversationServiceOptions = {
  engine: DronePluginEngine;
  config: DroneAgentConfig;
  logger: DroneLogger;
  sessionManager: DroneSessionManager;
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
  sessionManager,
  budgetService,
  maxToolIterations,
  stuckErrorThreshold = 3,
  onToolIterationLimitReached,
  onStuckErrorThresholdReached,
}: CreateConversationServiceOptions): ConversationService {
  let hasWarnedAboutSafetyTrim = false;

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
    return personaCap ? personaCap.getFilteredTools(allTools) : allTools;
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

  async function executeToolSafely(
    canonicalName: string,
    input: Record<string, unknown>
  ): Promise<
    | { kind: 'ok'; content: string }
    | { kind: 'error'; content: string; code: string | null }
  > {
    try {
      const content = await engine.executeTool(canonicalName, input);
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
      sessionManager.appendUserMessage(prompt);

      const llm = getLlmCapability();
      const provider = llm.getActiveProvider();
      const tools = getLlmTools();
      let iterationCount = 0;
      // Tracks the most recent failing tool signature and how many times
      // we've seen it in a row. Reset to null on any success or on a new
      // tool/error. If it reaches stuckErrorThreshold we abort the loop
      // with a clear "model is stuck" error rather than burning rounds.
      let stuckSignature: { name: string; code: string | null } | null = null;
      let stuckCount = 0;

      const emit = (event: ConversationEvent): void => {
        if (onEvent) {
          try {
            onEvent(event);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`Conversation event handler threw: ${message}`);
          }
        }
      };

      while (true) {
        const systemMessages = await budgetService.buildSystemMessages();
        await ensureSafeBudget(systemMessages, tools);

        const currentModel = llm.getModel();

        const response = await provider.chat({
          model: currentModel,
          messages: [...systemMessages, ...sessionManager.getMessages()],
          tools,
        });

        if (response.reasoning && response.reasoning.length > 0) {
          emit({ kind: 'reasoning', content: response.reasoning });
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
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

          sessionManager.appendAssistantMessage(
            response.message ?? '',
            response.toolCalls
          );

          // Collect tool results without appending to the session yet, so
          // that onAfterToolCall hooks observe a consistent session snapshot.
          // Results are flushed in order once the hooks have returned.
          const bufferedResults: Array<{
            name: string;
            content: string;
            toolCallId: string | undefined;
          }> = [];

          for (const toolCall of response.toolCalls) {
            emit({
              kind: 'toolCall',
              name: toolCall.name,
              arguments: toolCall.arguments,
            });
            const toolResult = await executeToolSafely(
              toolCall.name,
              toolCall.arguments
            );
            if (toolResult.kind === 'error') {
              emit({ kind: 'error', message: toolResult.content });
              // Update the stuck detector: only count this round's tool calls
              // if all of them fail with the SAME signature; otherwise reset.
              const signature = { name: toolCall.name, code: toolResult.code };
              if (
                stuckSignature &&
                stuckSignature.name === signature.name &&
                stuckSignature.code === signature.code
              ) {
                stuckCount += 1;
              } else {
                stuckSignature = signature;
                stuckCount = 1;
              }
            } else {
              emit({
                kind: 'toolResult',
                name: toolCall.name,
                content: toolResult.content,
                arguments: toolCall.arguments,
              });
              // Any successful tool call resets the stuck detector.
              stuckSignature = null;
              stuckCount = 0;
            }
            bufferedResults.push({
              name: toolCall.name,
              content: toolResult.content,
              toolCallId: toolCall.id,
            });
          }

          if (
            stuckSignature &&
            stuckCount >= stuckErrorThreshold &&
            // All tool calls in this round must have been errors; otherwise
            // the model is making progress even if some calls failed.
            bufferedResults.every(r =>
              r.content.startsWith(`${stuckSignature!.name} failed`)
            )
          ) {
            const codeSuffix = stuckSignature.code
              ? ` (${stuckSignature.code})`
              : '';
            if (onStuckErrorThresholdReached) {
              const shouldContinue = await onStuckErrorThresholdReached(
                stuckSignature.name,
                stuckSignature.code,
                stuckCount
              );
              if (shouldContinue) {
                // Reset the stuck detector and continue.
                stuckSignature = null;
                stuckCount = 0;
                continue;
              }
            }
            throw new Error(
              `Model appears stuck on ${stuckSignature.name}${codeSuffix}: ` +
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

          await engine.runHooks('onAfterToolCall');

          continue;
        }

        const assistantMessage = response.message ?? '';
        sessionManager.appendAssistantMessage(assistantMessage);
        if (assistantMessage.length > 0) {
          emit({ kind: 'assistantMessage', content: assistantMessage });
        }
        return assistantMessage;
      }
    },
    clearSession: () => {
      hasWarnedAboutSafetyTrim = false;
      sessionManager.clearSession();
    },
    getMessages: () => sessionManager.getMessages(),
    getEstimatedContextUsagePercent: () => estimateCurrentContextUsagePercent(),
    setModel: (newModel: string) => {
      getLlmCapability().setModel(newModel);
      budgetService.resetContextWindowCache();
    },
    getModel: () => getLlmCapability().getModel(),
  };
}
