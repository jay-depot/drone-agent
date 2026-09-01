import type {
  DroneAgentConfig,
  DroneLlmCapability,
  DroneLogger,
} from 'drone-core';
import type { DronePluginEngine } from './plugin-engine.js';
import {
  createConversationService,
  type ConversationService,
} from './conversation-service.js';
import { createSessionManager } from './session-manager.js';
import { createContextBudgetService } from './context-budget-service.js';

/**
 * A workflow-scoped conversation: a fresh in-memory session manager plus a
 * conversation service wired to the engine's LLM broker, prompt fragments,
 * and runtime flags. Agent steps sent through it share history with each
 * other but never touch the main session or any persistence — the whole
 * structure is garbage-collected when the workflow run ends.
 */
export type EphemeralConversation = {
  send: (prompt: string) => Promise<string>;
};

export function createEphemeralConversation(opts: {
  engine: DronePluginEngine;
  config: DroneAgentConfig;
  logger: DroneLogger;
}): EphemeralConversation {
  const { engine, config, logger } = opts;
  const sessionManager = createSessionManager();
  const budgetService = createContextBudgetService({
    config,
    renderPromptFragments: () => engine.renderPromptFragments(),
    getProvider: () => {
      const llm = engine.getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        throw new Error('LLM provider broker is not available.');
      }
      return llm.getActiveProvider();
    },
    getModel: () => {
      const llm = engine.getCapability<DroneLlmCapability>('llm');
      if (!llm) {
        throw new Error('LLM provider broker is not available.');
      }
      return llm.getModel();
    },
    runtimeFlags: () => engine.getRuntimeFlags(),
  });
  const conversation: ConversationService = createConversationService({
    engine,
    config,
    logger,
    sessionManager,
    budgetService,
  });
  return { send: prompt => conversation.sendUserMessage(prompt) };
}
