import { describe, expect, it, vi } from 'vitest';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import {
  createDefaultAgentConfig,
  createDebugFlagRegistry,
  filterByGlobPatterns,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DroneSessionTurn,
  type DroneToolDescriptor,
} from 'drone-core';
import {
  createConversationService,
  CANCEL_SENTINEL,
} from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import type { ContextBudgetService } from '../src/runtime/context-budget-service.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { createMockEngine, silentLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Test fixtures
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

/**
 * Build a fake DroneLlmCapability that wraps the given provider.
 * The model defaults to 'fake'.
 */
function makeLlmCapability(provider: DroneLlmProvider): DroneLlmCapability {
  return {
    getActiveProvider: () => provider,
    getActiveProviderId: () => 'test-provider',
    getAvailableProviders: () => [{ id: 'test-provider', precedence: 1000 }],
    activateProvider: () => {},
    getModel: () => 'fake',
    setModel: () => {},
    getReasoningLevel: () => undefined,
    setReasoningLevel: (_level: unknown) => {},
    listModels: async () => ['fake'],
    registerDriver: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
  };
}

it('uses the newly active provider on the next loop iteration', async () => {
  const engine = createMockEngine({
    tools: [
      {
        name: 'switch.provider',
        description: 'switch active provider',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    executeToolImpl: async () => {
      llm.activateProvider('provider-b');
      return 'switched';
    },
  });

  const providerA = makeProvider([
    {
      toolCalls: [
        {
          id: 'call-1',
          name: 'switch.provider',
          arguments: {},
        },
      ],
    },
    { message: 'provider-a-final' },
  ]);
  const providerB = makeProvider([{ message: 'provider-b-final' }]);

  const providers: Record<string, DroneLlmProvider> = {
    'provider-a': providerA,
    'provider-b': providerB,
  };
  let activeProviderId = 'provider-a';
  let model = 'fake-a';

  const llm: DroneLlmCapability = {
    getActiveProvider: () => providers[activeProviderId],
    getActiveProviderId: () => activeProviderId,
    getAvailableProviders: () => [
      { id: 'provider-a', precedence: 1000 },
      { id: 'provider-b', precedence: 1000 },
    ],
    activateProvider: providerId => {
      activeProviderId = providerId;
      model = providerId === 'provider-a' ? 'fake-a' : 'fake-b';
    },
    getModel: () => model,
    setModel: nextModel => {
      model = nextModel;
    },
    getReasoningLevel: () => undefined,
    setReasoningLevel: (_level: unknown) => {},
    listModels: async () =>
      activeProviderId === 'provider-a' ? ['fake-a'] : ['fake-b'],
    registerDriver: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
  };

  const config = createDefaultAgentConfig();
  const sessionManager = createSessionManager();
  const budgetService = createContextBudgetService({
    config,
    renderPromptFragments: async () => [],
    getProvider: () => llm.getActiveProvider(),
    getModel: () => llm.getModel(),
  });
  const conversation = createConversationService({
    engine: engine as unknown as DronePluginEngine,
    config,
    logger: silentLogger(),
    sessionManager,
    budgetService,
  });

  (engine as { getCapability: (id: string) => unknown }).getCapability = (
    id: string
  ) => (id === 'llm' ? llm : undefined);

  const finalMessage = await conversation.sendUserMessage('switch providers');
  expect(finalMessage).toBe('provider-b-final');
  expect(providerA.__chatMock).toHaveBeenCalledTimes(1);
  expect(providerB.__chatMock).toHaveBeenCalledTimes(1);
});

describe('createConversationService — tool error handling', () => {
  it('returns a successful tool result to the model when the tool succeeds', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'file__list',
          description: 'list dir',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => JSON.stringify({ items: [] }),
    });
    const provider = makeProvider([
      // First response: model wants to call the tool
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'file__list',
            arguments: { path: '/tmp' },
          },
        ],
      },
      // Second response: model finishes the turn with a final message
      { message: 'Done.' },
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
    // Inject provider via the engine's llm capability.
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    const finalMessage = await conversation.sendUserMessage('list /tmp');
    expect(finalMessage).toBe('Done.');

    // The successful tool output should be appended as a `tool` role message.
    const messages = sessionManager.getMessages();
    const toolMessage = messages.find(m => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toBe('{"items":[]}');
    expect(toolMessage?.toolName).toBe('file__list');
  });

  it('captures tool exceptions and surfaces them as tool messages — does not throw', async () => {
    const enoent = (() => {
      const e: NodeJS.ErrnoException = new Error(
        "ENOENT: no such file or directory, scandir '/drone'"
      );
      e.code = 'ENOENT';
      return e;
    })();

    const engine = createMockEngine({
      tools: [
        {
          name: 'file__list',
          description: 'list dir',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => {
        throw enoent;
      },
    });
    const provider = makeProvider([
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'file__list',
            arguments: { path: '/drone' },
          },
        ],
      },
      { message: 'I see, that path is missing.' },
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

    // Should not throw — model should receive the error and continue.
    const finalMessage = await conversation.sendUserMessage('list /drone');
    expect(finalMessage).toBe('I see, that path is missing.');

    const messages = sessionManager.getMessages();
    const toolMessage = messages.find(m => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    // Error must include the tool name, the error code, and a useful message.
    expect(toolMessage?.content).toContain('file__list');
    expect(toolMessage?.content).toContain('ENOENT');
    expect(toolMessage?.content).toContain('/drone');
  });

  it('emits an error event when a tool throws', async () => {
    const err: NodeJS.ErrnoException = new Error('boom');
    err.code = 'EACCES';

    const engine = createMockEngine({
      tools: [
        {
          name: 'file__read',
          description: 'read',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => {
        throw err;
      },
    });
    const provider = makeProvider([
      { toolCalls: [{ id: 'c', name: 'file__read', arguments: {} }] },
      { message: 'recovered' },
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
    await conversation.sendUserMessage('read x', evt => {
      if (evt.kind === 'error') events.push('error');
      if (evt.kind === 'toolCallBatch') events.push('toolCallBatch');
      if (evt.kind === 'toolResult') events.push('toolResult');
      if (evt.kind === 'toolResultBatch') events.push('toolResultBatch');
    });

    expect(events).toContain('error');
    expect(events).toContain('toolCallBatch');
    // toolResultBatch IS emitted (contains error content), but individual toolResult is not.
    expect(events).not.toContain('toolResult');
    expect(events).toContain('toolResultBatch');
  });

  it('continues the conversation loop after a tool error and lets the model retry', async () => {
    let attempt = 0;
    const engine = createMockEngine({
      tools: [
        {
          name: 'file__list',
          description: 'list',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          const e: NodeJS.ErrnoException = new Error('not found');
          e.code = 'ENOENT';
          throw e;
        }
        return JSON.stringify({ items: ['a', 'b'] });
      },
    });
    const provider = makeProvider([
      // Round 1: try /drone (fails)
      {
        toolCalls: [
          { id: '1', name: 'file__list', arguments: { path: '/drone' } },
        ],
      },
      // Round 2: try /home (succeeds)
      {
        toolCalls: [
          { id: '2', name: 'file__list', arguments: { path: '/home' } },
        ],
      },
      // Round 3: model summarises
      { message: 'Found 2 items in /home.' },
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

    const finalMessage = await conversation.sendUserMessage(
      'explore the project'
    );
    expect(finalMessage).toBe('Found 2 items in /home.');

    const messages = sessionManager.getMessages();
    const toolMessages = messages.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain('ENOENT');
    expect(toolMessages[1]?.content).toContain('items');
  });

  it('records tool call arguments in the assistant turn before running them', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'file__read',
          description: 'r',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => 'ok',
    });
    const provider = makeProvider([
      {
        toolCalls: [
          { id: 'tc1', name: 'file__read', arguments: { path: '/x' } },
        ],
      },
      { message: 'finished' },
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

    await conversation.sendUserMessage('go');

    // Each assistant message is its own turn: [user], [assistant+tool],
    // [assistant-final].
    const turns: DroneSessionTurn[] = sessionManager.getTurns();
    expect(turns).toHaveLength(3);
    expect(turns[0].messages.map(m => m.role)).toEqual(['user']);
    expect(turns[1].messages.map(m => m.role)).toEqual(['assistant', 'tool']);
    expect(turns[2].messages.map(m => m.role)).toEqual(['assistant']);
    const allMessages = turns.flatMap(t => t.messages);
    const assistantWithToolCall = allMessages.find(
      m => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
    );
    expect(assistantWithToolCall?.toolCalls?.[0]?.arguments).toEqual({
      path: '/x',
    });
  });
});

// ---------------------------------------------------------------------------
// maxToolIterations + stuck-detection
// ---------------------------------------------------------------------------

describe('createConversationService — iteration limits', () => {
  function makeErrnoEngine(): DronePluginEngine & {
    __executeMock: ReturnType<typeof vi.fn>;
  } {
    return createMockEngine({
      tools: [
        {
          name: 'file__list',
          description: 'list',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => {
        const e: NodeJS.ErrnoException = new Error('not found');
        e.code = 'ENOENT';
        throw e;
      },
    });
  }

  it('respects maxToolIterations from config when no override is given', async () => {
    const engine = makeErrnoEngine();
    // Queue more tool-call responses than the limit so the loop must bail.
    const responses: DroneChatResponse[] = Array.from({ length: 5 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file__list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 3;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      // Push the stuck threshold well above the iteration limit so the
      // depth limit (not the stuck detector) is what trips first.
      stuckErrorThreshold: 100,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 3/
    );
  });

  it('constructor argument overrides config and gives a clearer message', async () => {
    const engine = makeErrnoEngine();
    const responses: DroneChatResponse[] = Array.from({ length: 10 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file__list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 50; // would never fire on its own
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      maxToolIterations: 2,
      stuckErrorThreshold: 100,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 2/
    );
  });

  it('calls onToolIterationLimitReached and continues when callback returns true', async () => {
    const engine = makeErrnoEngine();
    // Queue enough tool-call responses to exceed the limit multiple times.
    const responses: DroneChatResponse[] = Array.from({ length: 8 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file__list', arguments: { path: '/missing' } },
      ],
    }));
    // After the last tool call, return a plain message so the loop ends.
    responses.push({ message: 'done' });
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 3;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const onLimitReached =
      vi.fn<(currentCount: number, maxCount: number) => Promise<boolean>>();
    onLimitReached.mockResolvedValue(true); // always continue

    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      stuckErrorThreshold: 100,
      onToolIterationLimitReached: onLimitReached,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    const result = await conversation.sendUserMessage('go');
    expect(result).toBe('done');
    // Should have been called at least once (the limit was hit and reset).
    expect(onLimitReached).toHaveBeenCalled();
    // The first call should report the exceeded count and the limit.
    expect(onLimitReached).toHaveBeenNthCalledWith(1, 4, 3);
  });

  it('throws the original error when onToolIterationLimitReached returns false', async () => {
    const engine = makeErrnoEngine();
    const responses: DroneChatResponse[] = Array.from({ length: 5 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file__list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 3;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const onLimitReached =
      vi.fn<(currentCount: number, maxCount: number) => Promise<boolean>>();
    onLimitReached.mockResolvedValue(false); // user says stop

    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      stuckErrorThreshold: 100,
      onToolIterationLimitReached: onLimitReached,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 3/
    );
    expect(onLimitReached).toHaveBeenCalledTimes(1);
  });

  it('throws the original error when no onToolIterationLimitReached is provided', async () => {
    const engine = makeErrnoEngine();
    const responses: DroneChatResponse[] = Array.from({ length: 5 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file__list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 3;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);

    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      stuckErrorThreshold: 100,
      // No onToolIterationLimitReached — should fall back to hard error.
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 3/
    );
  });
});

describe('createConversationService — stuck detection', () => {
  it('aborts early with a clear message after N consecutive same-error rounds', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'file__list',
          description: 'list',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => {
        const e: NodeJS.ErrnoException = new Error("scandir '/workspace'");
        e.code = 'ENOENT';
        throw e;
      },
    });
    // The model "retries" 10 times — the stuck detector should kill it after 3.
    const responses: DroneChatResponse[] = Array.from({ length: 10 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file__list', arguments: { path: '/workspace' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 50;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      // Tighten the threshold for a deterministic test.
      stuckErrorThreshold: 3,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Model appears stuck on file/
    );
  });

  it('does not trigger stuck detection if the model makes progress', async () => {
    let attempt = 0;
    const engine = createMockEngine({
      tools: [
        {
          name: 'file__list',
          description: 'list',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => {
        attempt += 1;
        if (attempt <= 2) {
          const e: NodeJS.ErrnoException = new Error('not found');
          e.code = 'ENOENT';
          throw e;
        }
        return JSON.stringify({ items: ['found'] });
      },
    });
    const provider = makeProvider([
      // Two failing rounds, then a successful round, then a final message.
      {
        toolCalls: [{ id: 'a', name: 'file__list', arguments: { path: '/a' } }],
      },
      {
        toolCalls: [{ id: 'b', name: 'file__list', arguments: { path: '/b' } }],
      },
      {
        toolCalls: [{ id: 'c', name: 'file__list', arguments: { path: '/c' } }],
      },
      { message: 'Found it.' },
    ]);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 50;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      stuckErrorThreshold: 3,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    const finalMessage = await conversation.sendUserMessage('go');
    expect(finalMessage).toBe('Found it.');
  });

  it('treats a different tool signature as a fresh start, not a continuation', async () => {
    const toolImpl = vi.fn(async (name: string): Promise<string> => {
      if (name === 'file__list') {
        const e: NodeJS.ErrnoException = new Error('not found');
        e.code = 'ENOENT';
        throw e;
      }
      if (name === 'search__text') {
        const e: NodeJS.ErrnoException = new Error('not found');
        e.code = 'ENOENT';
        throw e;
      }
      return 'ok';
    });

    const engine = createMockEngine({
      tools: [
        {
          name: 'file__list',
          description: 'list',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'search__text',
          description: 'text',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: toolImpl,
    });

    const provider = makeProvider([
      // 2x ENOENT from file.list, then 2x ENOENT from search.text —
      // each tool only failed twice, so the stuck detector (threshold 3)
      // should NOT fire. We exceed 3 rounds total, so this would only
      // pass if the detector resets on a new tool signature.
      {
        toolCalls: [
          { id: '1', name: 'file__list', arguments: {} },
          { id: '2', name: 'search__text', arguments: {} },
        ],
      },
      {
        toolCalls: [
          { id: '3', name: 'file__list', arguments: {} },
          { id: '4', name: 'search__text', arguments: {} },
        ],
      },
      { message: 'giving up' },
    ]);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 50;
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
      stuckErrorThreshold: 3,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    // Should NOT throw — each tool signature only failed twice (< threshold 3).
    const finalMessage = await conversation.sendUserMessage('go');
    expect(finalMessage).toBe('giving up');
  });
});

// ---------------------------------------------------------------------------
// Message queue and cancel
// ---------------------------------------------------------------------------

describe('createConversationService — message queue', () => {
  it('drains queued messages before the LLM call on the next loop iteration', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'fake_tool',
          description: 'no-op tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => 'ok',
    });
    // Provider: first response has tool calls (to trigger a loop iteration),
    // second response is a plain message (to exit).
    const provider = makeProvider([
      {
        toolCalls: [{ id: 'tc1', name: 'fake_tool', arguments: {} }],
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

    // Enqueue messages before starting — they'll be drained at the top of
    // the while(true) loop (after the tool round completes).
    conversation.enqueueUserMessage('queued-1');
    conversation.enqueueUserMessage('queued-2');

    const result = await conversation.sendUserMessage('first');
    expect(result).toBe('done');

    // Both queued messages should appear as user turns in the session.
    const messages = sessionManager.getMessages();
    const userMessages = messages.filter(m => m.role === 'user');
    expect(userMessages.map(m => m.content)).toContain('queued-1');
    expect(userMessages.map(m => m.content)).toContain('queued-2');
  });

  it('cancelCurrentRequest causes early return with CANCEL_SENTINEL', async () => {
    let cancelNow: (() => void) | null = null;

    const engine = createMockEngine({
      tools: [
        {
          name: 'fake_tool',
          description: 'no-op tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      // Cancel synchronously during tool execution so the flag is set
      // before the loop continuation check.
      executeToolImpl: async () => {
        if (cancelNow) cancelNow();
        return 'ok';
      },
    });

    // Provider returns tool calls to enter the loop.
    const provider = makeProvider([
      {
        toolCalls: [{ id: 'tc1', name: 'fake_tool', arguments: {} }],
      },
      { message: 'should not be reached' },
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

    cancelNow = () => conversation.cancelCurrentRequest();

    const result = await conversation.sendUserMessage('go');
    expect(result).toBe(CANCEL_SENTINEL);
  });

  it('cancel preserves queued messages for the next sendUserMessage call', async () => {
    let cancelNow: (() => void) | null = null;

    const engine = createMockEngine({
      tools: [
        {
          name: 'fake_tool',
          description: 'no-op tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => {
        if (cancelNow) cancelNow();
        return 'ok';
      },
    });

    const provider = makeProvider([
      {
        toolCalls: [{ id: 'tc1', name: 'fake_tool', arguments: {} }],
      },
      { message: 'final' },
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

    cancelNow = () => conversation.cancelCurrentRequest();

    // Enqueue a message before the first call, then cancel.
    conversation.enqueueUserMessage('preserve-me');
    const result1 = await conversation.sendUserMessage('first');
    expect(result1).toBe(CANCEL_SENTINEL);

    // Now call sendUserMessage again — it should drain the preserved queue.
    const result2 = await conversation.sendUserMessage('second');
    expect(result2).toBe('final');

    // The preserved message should appear in the session.
    const messages = sessionManager.getMessages();
    const userMessages = messages.filter(m => m.role === 'user');
    expect(userMessages.map(m => m.content)).toContain('preserve-me');
  });

  it('clearSession flushes the queue', async () => {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => 'ok',
    });
    const provider = makeProvider([{ message: 'hello' }]);

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

    // Enqueue, then clear, then send a new message.
    conversation.enqueueUserMessage('should-be-cleared');
    conversation.clearSession();

    const result = await conversation.sendUserMessage('fresh');
    expect(result).toBe('hello');

    // Only 'fresh' should appear as a user message.
    const messages = sessionManager.getMessages();
    const userMessages = messages.filter(m => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.content).toBe('fresh');
  });
});

// ── Tool result truncation ─────────────────────────────────────────────

describe('tool result truncation', () => {
  const LARGE_CONTENT = 'x'.repeat(100_000); // ~25K tokens
  const SMALL_CONTENT = 'ok';

  function makeTruncationProvider(
    chatResponses: DroneChatResponse[],
    contextWindowTokens: number
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
          contextWindowTokens,
          source: 'config',
        }) satisfies DroneContextWindowInfo,
      __chatMock: chatMock,
    };
  }

  it('truncates tool result exceeding 15% of context window', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'test__large',
          description: 'returns large output',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => LARGE_CONTENT,
    });
    const provider = makeTruncationProvider(
      [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'test__large',
              arguments: {},
            },
          ],
        },
        { message: 'Done.' },
      ],
      32768 // 15% = ~4915 tokens
    );

    const config = createDefaultAgentConfig();
    config.session.maxToolResultTokensPercent = 15;
    const sessionManager = createSessionManager();
    const budgetService = createContextBudgetService({
      config,
      renderPromptFragments: async () => [],
      getProvider: () => provider,
      getModel: () => 'fake',
    });
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

    await conversation.sendUserMessage('run large tool');

    const messages = sessionManager.getMessages();
    const toolMessage = messages.find(m => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content).toContain('[Output truncated at ~');
    expect(toolMessage!.content).toContain('Full output was ~25000 tokens');
    expect(toolMessage!.content).toContain('request a smaller window');
    // The truncated content should be shorter than the original
    expect(toolMessage!.content.length).toBeLessThan(LARGE_CONTENT.length);
  });

  it('passes through small tool result unchanged', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'test__small',
          description: 'returns small output',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => SMALL_CONTENT,
    });
    const provider = makeTruncationProvider(
      [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'test__small',
              arguments: {},
            },
          ],
        },
        { message: 'Done.' },
      ],
      32768
    );

    const config = createDefaultAgentConfig();
    config.session.maxToolResultTokensPercent = 15;
    const sessionManager = createSessionManager();
    const budgetService = createContextBudgetService({
      config,
      renderPromptFragments: async () => [],
      getProvider: () => provider,
      getModel: () => 'fake',
    });
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

    await conversation.sendUserMessage('run small tool');

    const messages = sessionManager.getMessages();
    const toolMessage = messages.find(m => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content).toBe(SMALL_CONTENT);
  });

  it('does not truncate when maxToolResultTokensPercent is 0', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'test__large',
          description: 'returns large output',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => LARGE_CONTENT,
    });
    const provider = makeTruncationProvider(
      [
        {
          toolCalls: [
            {
              id: 'call-1',
              name: 'test__large',
              arguments: {},
            },
          ],
        },
        { message: 'Done.' },
      ],
      32768
    );

    const config = createDefaultAgentConfig();
    config.session.maxToolResultTokensPercent = 0;
    const sessionManager = createSessionManager();
    const budgetService = createContextBudgetService({
      config,
      renderPromptFragments: async () => [],
      getProvider: () => provider,
      getModel: () => 'fake',
    });
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

    await conversation.sendUserMessage('run large tool');

    const messages = sessionManager.getMessages();
    const toolMessage = messages.find(m => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    // Content should be the full large content, not truncated
    expect(toolMessage!.content).toBe(LARGE_CONTENT);
  });
});

describe('createConversationService — mounted tool list visibility filtering', () => {
  function makePersonaCap(allowedTools?: string[]): {
    getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
  } {
    return {
      getFilteredTools: (tools: DroneToolDescriptor[]) => {
        if (!allowedTools) {
          return tools.filter(t => !t.defaultHidden);
        }
        const names = tools.map(t => t.name);
        const filtered = filterByGlobPatterns(names, allowedTools);
        const filteredSet = new Set(filtered);
        return tools.filter(t => filteredSet.has(t.name));
      },
    };
  }

  async function runAndGetSentTools(
    engine: DronePluginEngine,
    provider: DroneLlmProvider & { __chatMock: ReturnType<typeof vi.fn> },
    personaCap?: {
      getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
    }
  ): Promise<DroneToolDescriptor[]> {
    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine,
      config,
      logger: silentLogger(),
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => {
      if (id === 'llm') return makeLlmCapability(provider);
      if (id === 'persona') return personaCap;
      return undefined;
    };

    await conversation.sendUserMessage('go');
    const firstCall = provider.__chatMock.mock.calls[0][0] as {
      tools?: DroneToolDescriptor[];
    };
    return firstCall.tools ?? [];
  }

  it('filters default-hidden tools from the mounted list when no persona is present', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'term__create',
          description: 'create a terminal session',
          defaultHidden: true,
        },
        {
          name: 'term__list',
          description: 'list terminal sessions',
        },
      ],
      executeToolImpl: async () => 'ok',
    });
    const provider = makeProvider([{ message: 'done' }]);

    const sentTools = await runAndGetSentTools(
      engine as unknown as DronePluginEngine,
      provider
    );
    const names = sentTools.map(t => t.name);
    expect(names).toContain('term__list');
    expect(names).not.toContain('term__create');
  });

  it('applies the persona overlay to the mounted list', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'term__create',
          description: 'create a terminal session',
          defaultHidden: true,
        },
        {
          name: 'term__list',
          description: 'list terminal sessions',
        },
      ],
      executeToolImpl: async () => 'ok',
    });
    const provider = makeProvider([{ message: 'done' }]);

    const sentTools = await runAndGetSentTools(
      engine as unknown as DronePluginEngine,
      provider,
      makePersonaCap(['term__create'])
    );
    const names = sentTools.map(t => t.name);
    expect(names).toContain('term__create');
    expect(names).not.toContain('term__list');
  });
});

describe('createConversationService — llm debug flag', () => {
  it('passes debug: true to provider.chat() when llm is enabled in the shared registry', async () => {
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => 'ok',
    });
    const provider = makeProvider([{ message: 'hello' }]);
    const debugFlags = createDebugFlagRegistry(['llm']);

    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const budgetService = makeBudgetService(provider);
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: silentLogger(),
      debugFlags,
      sessionManager,
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    await conversation.sendUserMessage('hi');
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    const chatInput = provider.__chatMock.mock.calls[0][0] as {
      debug?: boolean;
    };
    expect(chatInput.debug).toBe(true);
  });
});

describe('createConversationService — stopLoop signal', () => {
  it('breaks the tool-call loop when a tool calls context.stopLoop()', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'subagent__return',
          description: 'return to parent',
          inputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
          },
        },
      ],
      executeToolImpl: async (name, input, onProgress, context) => {
        // Simulate the subagent__return tool: signal the loop to stop
        if (name === 'subagent__return') {
          context?.stopLoop?.();
          return JSON.stringify({ returned: true, result: input.result });
        }
        return 'ok';
      },
    });

    const provider = makeProvider([
      // First response: model calls the return tool
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'subagent__return',
            arguments: { result: 'done' },
          },
        ],
      },
      // Second response: model finishes the turn (should NOT be reached)
      { message: 'should-not-be-reached' },
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

    const result = await conversation.sendUserMessage('return');

    // The loop should break after the return tool, returning the assistant message.
    // The provider should only be called once (not twice for the second message).
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    // response.message is undefined when only toolCalls are present
    expect(result).toBe('');
  });
});

describe('createConversationService — subagent__return canonical naming', () => {
  it('emits toolCallBatch with the canonical subagent__return name', async () => {
    const engine = createMockEngine({
      tools: [
        {
          name: 'subagent__return',
          description: 'return to parent',
          inputSchema: {
            type: 'object',
            properties: {
              result: { type: 'string' },
            },
          },
        },
      ],
      executeToolImpl: async (name, input, onProgress, context) => {
        if (name === 'subagent__return') {
          context?.stopLoop?.();
          return JSON.stringify({ returned: true, result: input.result });
        }
        return 'ok';
      },
    });

    const provider = makeProvider([
      {
        toolCalls: [
          {
            id: 'call-1',
            name: 'subagent__return',
            arguments: { result: 'done' },
          },
        ],
      },
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

    const batchNames: string[] = [];
    await conversation.sendUserMessage('return', evt => {
      if (evt.kind === 'toolCallBatch') {
        for (const tc of evt.toolCalls) {
          batchNames.push(tc.name);
        }
      }
    });

    // The toolCallBatch event must expose the canonical name so that
    // interactive.ts's hasExplicitReturn check (against 'subagent__return') matches.
    expect(batchNames).toContain('subagent__return');
  });
});
