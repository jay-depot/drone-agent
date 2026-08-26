import { describe, expect, it, vi } from 'vitest';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import {
  createDefaultAgentConfig,
  type DroneChatMessage,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
} from 'drone-core';
import { createConversationService } from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import type { ContextBudgetService } from '../src/runtime/context-budget-service.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { createMockEngine, silentLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Test fixtures (mirrors conversation-service.test.ts)
// ---------------------------------------------------------------------------

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
    resolveModelForRole: () => ({
      provider,
      providerId: 'test-provider',
      model: 'fake',
    }),
    getActiveProviderId: () => 'test-provider',
    getAvailableProviders: () => [{ id: 'test-provider', precedence: 1000 }],
    activateProvider: () => {},
    getModel: () => 'fake',
    setModel: () => {},
    getReasoningLevel: () => undefined,
    setReasoningLevel: (_level: any) => {},
    listModels: async () => ['fake'],
    registerDriver: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests for new event kinds
// ---------------------------------------------------------------------------

describe('conversation service — new batch events', () => {
  it('emits toolCallBatch and toolResultBatch events for successful tool calls', async () => {
    const engine = createMockEngine({
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

    const engine = createMockEngine({
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
    const engine = createMockEngine({
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
    const engine = createMockEngine({
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

// ---------------------------------------------------------------------------
// System reminder drain
// ---------------------------------------------------------------------------

describe('conversation service — system reminders', () => {
  it('delivers a queued reminder exactly once as a non-persisted system message', async () => {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => '',
    });
    const provider = makeProvider([
      { message: 'first reply' },
      { message: 'second reply' },
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

    const queue = engine.__reminderQueue;
    queue.queue(
      'Context is approaching the compaction threshold (~4k tokens).'
    );

    await conversation.sendUserMessage('hello one', () => {});
    const firstCallMessages = provider.__chatMock.mock.calls[0][0]
      .messages as DroneChatMessage[];
    const remindersInFirstCall = firstCallMessages.filter(
      message =>
        message.role === 'system' &&
        message.content.includes('approaching the compaction threshold')
    );
    expect(remindersInFirstCall).toHaveLength(1);

    // One-shot: the reminder must not appear in the next call, and it must
    // never enter session history.
    await conversation.sendUserMessage('hello two', () => {});
    const secondCallMessages = provider.__chatMock.mock.calls[1][0]
      .messages as DroneChatMessage[];
    expect(
      secondCallMessages.filter(
        message =>
          message.role === 'system' &&
          message.content.includes('approaching the compaction threshold')
      )
    ).toHaveLength(0);
    expect(
      sessionManager.getMessages().filter(m => m.role === 'system')
    ).toHaveLength(0);
  });

  it('clears queued reminders on session clear', async () => {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => '',
    });
    const provider = makeProvider([{ message: 'reply' }]);

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

    const queue = engine.__reminderQueue;
    queue.queue('stale pre-compaction reminder');

    conversation.clearSession();

    await conversation.sendUserMessage('fresh start', () => {});
    const callMessages = provider.__chatMock.mock.calls[0][0]
      .messages as DroneChatMessage[];
    expect(
      callMessages.filter(message =>
        message.content.includes('stale pre-compaction reminder')
      )
    ).toHaveLength(0);
  });
});
