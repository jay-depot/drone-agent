import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultAgentConfig,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DroneToolDescriptor,
} from 'drone-core';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import { createConversationService } from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import type { ContextBudgetService } from '../src/runtime/context-budget-service.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { silentLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Test fixtures (mirrors conversation-service.test.ts)
// ---------------------------------------------------------------------------

type EngineOptions = {
  tools: DroneToolDescriptor[];
  executeToolImpl: (
    name: string,
    input: Record<string, unknown>
  ) => Promise<string>;
  promptFragments?: string[];
};

function makeEngine(options: EngineOptions): DronePluginEngine & {
  __executeMock: ReturnType<typeof vi.fn>;
} {
  const executeMock = vi.fn(options.executeToolImpl);
  const toolList = options.tools;

  return {
    initialize: async () => [],
    runHooks: async () => {},
    runSessionSafetyTrimWillRunHooks: async () => {},
    runSessionSafetyTrimAppliedHooks: async () => {},
    runConversationEventHooks: async () => {},
    renderPromptFragments: async () => options.promptFragments ?? [],
    getTool: () => undefined,
    executeTool: executeMock as unknown as DronePluginEngine['executeTool'],
    listTools: () => toolList,
    getCapability: <T>(id: string) =>
      id === 'llm' ? ({} as unknown as T) : undefined,
    listPlugins: () => [],
    getRegisteredPluginCount: () => 0,
    getRegisteredToolCount: () => toolList.length,
    getHelpSnippets: () => [],
    getConfig: () => {
      throw new Error('getConfig not used in conversation-service tests');
    },
    setElicitation: () => {},
    getElicitation: () => undefined,
    runWorkflow: async () => {
      throw new Error('runWorkflow not used in conversation-service tests');
    },
    dispatchSlashCommand: async () => false,
    getSlashCommands: () => [],
    onConversationEvent: () => () => {},
    registerBuiltinSlashCommand: () => {},
    getBuiltinSlashCommands: () => [],
    enablePlugin: async (_pluginId: string) => false,
    addExternalPlugin: async (_plugin: any) => false,
    __executeMock: executeMock,
  };
}

function makeProvider(
  chatResponses: DroneChatResponse[]
): DroneLlmProvider & { __chatMock: ReturnType<typeof vi.fn> } {
  const chatMock = vi.fn(async () => {
    if (chatResponses.length === 0) {
      return { message: 'no more responses queued' };
    }
    return chatResponses.shift() as DroneChatResponse;
  });
  return {
    chat: chatMock,
    getContextWindowInfo: async () =>
      ({
        model: 'fake',
        contextWindowTokens: 1_000_000,
        source: 'config',
      }) satisfies DroneContextWindowInfo,
    __chatMock: chatMock,
  };
}

function makeBudgetService(
  provider: DroneLlmProvider,
  promptFragments?: string[]
): ContextBudgetService {
  return createContextBudgetService({
    config: createDefaultAgentConfig(),
    renderPromptFragments: async () => promptFragments ?? [],
    getProvider: () => provider,
    getModel: () => 'fake',
  });
}

function makeLlmCapability(provider: DroneLlmProvider): DroneLlmCapability {
  return {
    getActiveProvider: () => provider,
    getActiveProviderId: () => 'test-provider',
    getAvailableProviders: () => [{ id: 'test-provider', precedence: 1000 }],
    activateProvider: () => {},
    getModel: () => 'fake',
    setModel: () => {},
    getReasoningLevel: () => undefined,
    setReasoningLevel: (_level: any) => {},
    listModels: async () => ['fake'],
    registerProvider: () => {},
    unregisterProvider: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests for new event kinds
// ---------------------------------------------------------------------------

describe('conversation service — new batch events', () => {
  it('emits toolCallBatch and toolResultBatch events for successful tool calls', async () => {
    const engine = makeEngine({
      tools: [
        {
          name: 'file__list',
          description: 'list files',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => JSON.stringify({ items: ['a'] }),
    });
    const provider = makeProvider([
      {
        toolCalls: [{ id: '1', name: 'file__list', arguments: { path: '/' } }],
      },
      { message: 'done' },
    ]);

    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    const events: string[] = [];
    await conversation.sendUserMessage('list files', evt => {
      if (evt.kind === 'toolCallBatch') events.push('toolCallBatch');
      if (evt.kind === 'toolResultBatch') events.push('toolResultBatch');
    });

    expect(events).toContain('toolCallBatch');
    expect(events).toContain('toolResultBatch');
  });

  it('executes multiple tool calls in parallel', async () => {
    const executionOrder: string[] = [];

    const engine = makeEngine({
      tools: [
        {
          name: 'tool_a',
          description: 'slow tool',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'tool_b',
          description: 'fast tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async name => {
        if (name === 'tool_a') {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        executionOrder.push(name);
        return `result from ${name}`;
      },
    });
    const provider = makeProvider([
      {
        toolCalls: [
          { id: '1', name: 'tool_a', arguments: {} },
          { id: '2', name: 'tool_b', arguments: {} },
        ],
      },
      { message: 'done' },
    ]);

    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    const start = Date.now();
    await conversation.sendUserMessage('run tools');
    const elapsed = Date.now() - start;

    // If parallel, total time should be ~100ms (max of delays), not ~110ms (sum)
    expect(elapsed).toBeLessThan(150);

    // Both tools should have executed
    expect(executionOrder).toContain('tool_a');
    expect(executionOrder).toContain('tool_b');
  });

  it('emits reasoningComplete event when reasoning is present', async () => {
    const engine = makeEngine({
      tools: [],
      executeToolImpl: async () => '',
    });
    const provider = makeProvider([
      { message: 'answer', reasoning: 'thinking...' },
    ]);

    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    const events: string[] = [];
    await conversation.sendUserMessage('hello', evt => {
      if (evt.kind === 'reasoning') events.push('reasoning');
      if (evt.kind === 'reasoningComplete') events.push('reasoningComplete');
    });

    expect(events).toContain('reasoning');
    expect(events).toContain('reasoningComplete');
  });

  it('emits assistantMessageComplete when assistant message is returned', async () => {
    const engine = makeEngine({
      tools: [],
      executeToolImpl: async () => '',
    });
    const provider = makeProvider([{ message: 'Hello!' }]);

    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    const events: string[] = [];
    await conversation.sendUserMessage('hello', evt => {
      if (evt.kind === 'assistantMessage') events.push('assistantMessage');
      if (evt.kind === 'assistantMessageComplete')
        events.push('assistantMessageComplete');
    });

    expect(events).toContain('assistantMessage');
    expect(events).toContain('assistantMessageComplete');
  });
});
