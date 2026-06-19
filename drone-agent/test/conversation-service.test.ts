import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultAgentConfig,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneLlmProvider,
  type DronePluginEngine,
  type DroneSessionTurn,
  type DroneToolDescriptor,
} from 'drone-core';
import { createConversationService } from '../src/runtime/conversation-service.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { silentLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

type EngineOptions = {
  tools: DroneToolDescriptor[];
  // The executeTool mock returns a string on success, or throws on error.
  // Tests pass in a real or stubbed function so the service can route
  // errors back to the model as tool messages.
  executeToolImpl: (name: string, input: Record<string, unknown>) => Promise<string>;
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
    renderPromptFragments: async () => options.promptFragments ?? [],
    getTool: () => undefined,
    executeTool: executeMock as unknown as DronePluginEngine['executeTool'],
    listTools: () => toolList,
    getCapability: <T>(id: string) =>
      id === 'ollama' ? ({} as unknown as T) : undefined,
    listPlugins: () => [],
    getRegisteredPluginCount: () => 0,
    getRegisteredToolCount: () => toolList.length,
    getHelpSnippets: () => [],
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

describe('createConversationService — tool error handling', () => {
  it('returns a successful tool result to the model when the tool succeeds', async () => {
    const engine = makeEngine({
      tools: [
        {
          name: 'file.list',
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
            name: 'file.list',
            arguments: { path: '/tmp' },
          },
        ],
      },
      // Second response: model finishes the turn with a final message
      { message: 'Done.' },
    ]);

    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      model: 'fake',
      config,
      logger: silentLogger(),
      sessionManager,
    });
    // Inject provider via the engine's ollama capability.
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'ollama' ? { provider } : undefined);

    const finalMessage = await conversation.sendUserMessage('list /tmp');
    expect(finalMessage).toBe('Done.');

    // The successful tool output should be appended as a `tool` role message.
    const messages = sessionManager.getMessages();
    const toolMessage = messages.find(m => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toBe('{"items":[]}');
    expect(toolMessage?.toolName).toBe('file.list');
  });

  it('captures tool exceptions and surfaces them as tool messages — does not throw', async () => {
    const enoent = (() => {
      const e: NodeJS.ErrnoException = new Error(
        "ENOENT: no such file or directory, scandir '/drone'"
      );
      e.code = 'ENOENT';
      return e;
    })();

    const engine = makeEngine({
      tools: [
        {
          name: 'file.list',
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
            name: 'file.list',
            arguments: { path: '/drone' },
          },
        ],
      },
      { message: 'I see, that path is missing.' },
    ]);

    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      model: 'fake',
      config,
      logger: silentLogger(),
      sessionManager,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'ollama' ? { provider } : undefined);

    // Should not throw — model should receive the error and continue.
    const finalMessage = await conversation.sendUserMessage('list /drone');
    expect(finalMessage).toBe('I see, that path is missing.');

    const messages = sessionManager.getMessages();
    const toolMessage = messages.find(m => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    // Error must include the tool name, the error code, and a useful message.
    expect(toolMessage?.content).toContain('file.list');
    expect(toolMessage?.content).toContain('ENOENT');
    expect(toolMessage?.content).toContain('/drone');
  });

  it('emits an error event when a tool throws', async () => {
    const err: NodeJS.ErrnoException = new Error('boom');
    err.code = 'EACCES';

    const engine = makeEngine({
      tools: [
        {
          name: 'file.read',
          description: 'read',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => {
        throw err;
      },
    });
    const provider = makeProvider([
      { toolCalls: [{ id: 'c', name: 'file.read', arguments: {} }] },
      { message: 'recovered' },
    ]);

    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      model: 'fake',
      config,
      logger: silentLogger(),
      sessionManager,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'ollama' ? { provider } : undefined);

    const events: string[] = [];
    await conversation.sendUserMessage('read x', evt => {
      if (evt.kind === 'error') events.push('error');
      if (evt.kind === 'toolCall') events.push('toolCall');
      if (evt.kind === 'toolResult') events.push('toolResult');
    });

    expect(events).toContain('error');
    expect(events).toContain('toolCall');
    // We should NOT emit a toolResult for a failed call (it's an error).
    expect(events).not.toContain('toolResult');
  });

  it('continues the conversation loop after a tool error and lets the model retry', async () => {
    let attempt = 0;
    const engine = makeEngine({
      tools: [
        {
          name: 'file.list',
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
      { toolCalls: [{ id: '1', name: 'file.list', arguments: { path: '/drone' } }] },
      // Round 2: try /home (succeeds)
      { toolCalls: [{ id: '2', name: 'file.list', arguments: { path: '/home' } }] },
      // Round 3: model summarises
      { message: 'Found 2 items in /home.' },
    ]);

    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      model: 'fake',
      config,
      logger: silentLogger(),
      sessionManager,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'ollama' ? { provider } : undefined);

    const finalMessage = await conversation.sendUserMessage('explore the project');
    expect(finalMessage).toBe('Found 2 items in /home.');

    const messages = sessionManager.getMessages();
    const toolMessages = messages.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toContain('ENOENT');
    expect(toolMessages[1]?.content).toContain('items');
  });

  it('records tool call arguments in the assistant turn before running them', async () => {
    const engine = makeEngine({
      tools: [
        {
          name: 'file.read',
          description: 'r',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      executeToolImpl: async () => 'ok',
    });
    const provider = makeProvider([
      { toolCalls: [{ id: 'tc1', name: 'file.read', arguments: { path: '/x' } }] },
      { message: 'finished' },
    ]);
    const config = createDefaultAgentConfig();
    const sessionManager = createSessionManager();
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      model: 'fake',
      config,
      logger: silentLogger(),
      sessionManager,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'ollama' ? { provider } : undefined);

    await conversation.sendUserMessage('go');

    // User / assistant-with-tool / tool / assistant-final all live in the
    // same turn (see session-manager.appendToCurrentTurn).
    const turns: DroneSessionTurn[] = sessionManager.getTurns();
    expect(turns.length).toBeGreaterThanOrEqual(1);
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
    return makeEngine({
      tools: [
        {
          name: 'file.list',
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
        { id: 'c', name: 'file.list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 3;
    const sessionManager = createSessionManager();
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      model: 'fake',
      config,
      logger: silentLogger(),
      sessionManager,
      // Push the stuck threshold well above the iteration limit so the
      // depth limit (not the stuck detector) is what trips first.
      stuckErrorThreshold: 100,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'ollama' ? { provider } : undefined);

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 3/
    );
  });

  it('constructor argument overrides config and gives a clearer message', async () => {
    const engine = makeErrnoEngine();
    const responses: DroneChatResponse[] = Array.from({ length: 10 }, () => ({
      toolCalls: [
        { id: 'c', name: 'file.list', arguments: { path: '/missing' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 50; // would never fire on its own
    const sessionManager = createSessionManager();
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      model: 'fake',
      config,
      logger: silentLogger(),
      sessionManager,
      maxToolIterations: 2,
      stuckErrorThreshold: 100,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'ollama' ? { provider } : undefined);

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Tool call depth exceeded the configured session limit of 2/
    );
  });
});

describe('createConversationService — stuck detection', () => {
  it('aborts early with a clear message after N consecutive same-error rounds', async () => {
    const engine = makeEngine({
      tools: [
        {
          name: 'file.list',
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
        { id: 'c', name: 'file.list', arguments: { path: '/workspace' } },
      ],
    }));
    const provider = makeProvider(responses);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 50;
    const sessionManager = createSessionManager();
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      model: 'fake',
      config,
      logger: silentLogger(),
      sessionManager,
      // Tighten the threshold for a deterministic test.
      stuckErrorThreshold: 3,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'ollama' ? { provider } : undefined);

    await expect(conversation.sendUserMessage('go')).rejects.toThrow(
      /Model appears stuck on file\.list \(ENOENT\): failed 3 times in a row/
    );
  });

  it('does not trigger stuck detection if the model makes progress', async () => {
    let attempt = 0;
    const engine = makeEngine({
      tools: [
        {
          name: 'file.list',
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
      { toolCalls: [{ id: 'a', name: 'file.list', arguments: { path: '/a' } }] },
      { toolCalls: [{ id: 'b', name: 'file.list', arguments: { path: '/b' } }] },
      { toolCalls: [{ id: 'c', name: 'file.list', arguments: { path: '/c' } }] },
      { message: 'Found it.' },
    ]);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 50;
    const sessionManager = createSessionManager();
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      model: 'fake',
      config,
      logger: silentLogger(),
      sessionManager,
      stuckErrorThreshold: 3,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'ollama' ? { provider } : undefined);

    const finalMessage = await conversation.sendUserMessage('go');
    expect(finalMessage).toBe('Found it.');
  });

  it('treats a different tool signature as a fresh start, not a continuation', async () => {
    const toolImpl = vi.fn(
      async (name: string): Promise<string> => {
        if (name === 'file.list') {
          const e: NodeJS.ErrnoException = new Error('not found');
          e.code = 'ENOENT';
          throw e;
        }
        if (name === 'search.text') {
          const e: NodeJS.ErrnoException = new Error('not found');
          e.code = 'ENOENT';
          throw e;
        }
        return 'ok';
      }
    );

    const engine = makeEngine({
      tools: [
        {
          name: 'file.list',
          description: 'list',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'search.text',
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
          { id: '1', name: 'file.list', arguments: {} },
          { id: '2', name: 'search.text', arguments: {} },
        ],
      },
      {
        toolCalls: [
          { id: '3', name: 'file.list', arguments: {} },
          { id: '4', name: 'search.text', arguments: {} },
        ],
      },
      { message: 'giving up' },
    ]);

    const config = createDefaultAgentConfig();
    config.session.maxToolIterations = 50;
    const sessionManager = createSessionManager();
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      model: 'fake',
      config,
      logger: silentLogger(),
      sessionManager,
      stuckErrorThreshold: 3,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'ollama' ? { provider } : undefined);

    // Should NOT throw — each tool signature only failed twice (< threshold 3).
    const finalMessage = await conversation.sendUserMessage('go');
    expect(finalMessage).toBe('giving up');
  });
});
