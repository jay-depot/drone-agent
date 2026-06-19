import type {
  DroneAgentConfig,
  DroneChatMessage,
  DroneContextWindowInfo,
  DroneLlmProvider,
  DroneLogger,
  DroneSessionSafetyTrimPayload,
} from 'drone-core';
import type { DronePluginEngine } from './plugin-engine.js';
import type { DroneSessionManager } from './session-manager.js';
import { estimateSessionBudget } from './token-estimator.js';

type OllamaCapability = {
  provider: DroneLlmProvider;
};

export type ConversationEvent =
  | { kind: 'reasoning'; content: string }
  | { kind: 'assistantMessage'; content: string }
  | { kind: 'toolCall'; name: string; arguments: Record<string, unknown> }
  | { kind: 'toolResult'; name: string; content: string }
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
  model: string;
  config: DroneAgentConfig;
  logger: DroneLogger;
  sessionManager: DroneSessionManager;
  maxToolIterations?: number;
};

export function createConversationService({
  engine,
  model: initialModel,
  config,
  logger,
  sessionManager,
  maxToolIterations = 8,
}: CreateConversationServiceOptions): ConversationService {
  let hasWarnedAboutSafetyTrim = false;
  let contextWindowInfoPromise: Promise<DroneContextWindowInfo> | undefined;
  let currentModel = initialModel;

  function buildSystemMessages(): DroneChatMessage[] {
    const base: DroneChatMessage[] = [
      { role: 'system', content: config.systemPrompt },
    ];
    // Plugin prompt fragments come after the base system prompt.
    return base;
  }

  function getProvider(): DroneLlmProvider {
    const ollama = engine.getCapability<OllamaCapability>('ollama');
    if (!ollama) {
      throw new Error('Ollama provider is not available.');
    }

    return ollama.provider;
  }

  async function resolveContextWindowInfo(
    provider: DroneLlmProvider
  ): Promise<DroneContextWindowInfo> {
    contextWindowInfoPromise ??= (async () => {
      const probed = await provider.getContextWindowInfo?.({
        model: currentModel,
      });
      if (probed) {
        return probed;
      }

      return {
        model: currentModel,
        contextWindowTokens: config.session.contextWindowTokens,
        source: 'config',
      };
    })();

    return contextWindowInfoPromise;
  }

  function computeRequiredDropTurnCount(input: {
    systemMessages: DroneChatMessage[];
    tools: ReturnType<DronePluginEngine['listTools']>;
    contextWindowTokens: number;
    turns: ReturnType<DroneSessionManager['getTurns']>;
  }): number | null {
    for (
      let dropTurnCount = 1;
      dropTurnCount <= input.turns.length;
      dropTurnCount += 1
    ) {
      const candidateBudget = estimateSessionBudget({
        systemMessages: input.systemMessages,
        turns: input.turns.slice(dropTurnCount),
        tools: input.tools,
        sessionConfig: config.session,
        contextWindowTokens: input.contextWindowTokens,
      });

      if (!candidateBudget.requiresSafetyTrim) {
        return dropTurnCount;
      }
    }

    return null;
  }

  async function ensureSafeBudget(
    provider: DroneLlmProvider,
    systemMessages: DroneChatMessage[],
    tools: ReturnType<DronePluginEngine['listTools']>
  ): Promise<void> {
    const contextWindow = await resolveContextWindowInfo(provider);

    while (true) {
      const currentTurns = sessionManager.getTurns();
      const budget = estimateSessionBudget({
        systemMessages,
        turns: currentTurns,
        tools,
        sessionConfig: config.session,
        contextWindowTokens: contextWindow.contextWindowTokens,
      });

      if (!budget.requiresSafetyTrim) {
        return;
      }

      const requiredDropTurnCount = computeRequiredDropTurnCount({
        systemMessages,
        tools,
        contextWindowTokens: contextWindow.contextWindowTokens,
        turns: currentTurns,
      });

      if (requiredDropTurnCount === null) {
        throw new Error(
          `Session exceeds the safe context budget for ${currentModel}, and no conversational turns remain to drop. Use /clear to reset the session.`
        );
      }

      const payload: DroneSessionSafetyTrimPayload = {
        model: currentModel,
        contextWindow,
        budget,
        currentTurns,
        proposedDropTurnCount: requiredDropTurnCount,
      };

      await engine.runSessionSafetyTrimWillRunHooks(payload);

      const turnsToDrop = Math.max(1, payload.proposedDropTurnCount);
      const droppedTurns = sessionManager.dropOldestTurns(turnsToDrop);
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
    const provider = getProvider();
    const tools = engine.listTools();
    const systemMessages = [
      ...buildSystemMessages(),
      ...(await engine.renderPromptFragments()).map(
        content => ({ role: 'system', content }) satisfies DroneChatMessage
      ),
    ];
    const contextWindow = await resolveContextWindowInfo(provider);
    const budget = estimateSessionBudget({
      systemMessages,
      turns: sessionManager.getTurns(),
      tools,
      sessionConfig: config.session,
      contextWindowTokens: contextWindow.contextWindowTokens,
    });

    const ratio =
      budget.estimatedPromptTokens / contextWindow.contextWindowTokens;
    const percent = Math.round(ratio * 100);
    if (!Number.isFinite(percent) || percent < 0) {
      return 0;
    }

    return Math.min(percent, 100);
  }

  return {
    sendUserMessage: async (prompt, onEvent) => {
      hasWarnedAboutSafetyTrim = false;
      sessionManager.appendUserMessage(prompt);

      const provider = getProvider();
      const tools = engine.listTools();
      let iterationCount = 0;

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
        const systemMessages = [
          ...buildSystemMessages(),
          ...(await engine.renderPromptFragments()).map(
            content => ({ role: 'system', content }) satisfies DroneChatMessage
          ),
        ];
        await ensureSafeBudget(provider, systemMessages, tools);

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
          if (iterationCount > maxToolIterations) {
            throw new Error(
              'Tool call depth exceeded the current session limit.'
            );
          }

          sessionManager.appendAssistantMessage(
            response.message ?? '',
            response.toolCalls
          );

          for (const toolCall of response.toolCalls) {
            emit({
              kind: 'toolCall',
              name: toolCall.name,
              arguments: toolCall.arguments,
            });
            const toolResult = await engine.executeTool(
              toolCall.name,
              toolCall.arguments
            );
            emit({ kind: 'toolResult', name: toolCall.name, content: toolResult });
            sessionManager.appendToolResult(
              toolCall.name,
              toolResult,
              toolCall.id
            );
          }

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
      currentModel = newModel;
      contextWindowInfoPromise = undefined; // Reset so next call re-probes
    },
    getModel: () => currentModel,
  };
}
