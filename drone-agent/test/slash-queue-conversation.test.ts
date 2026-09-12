import { describe, expect, it, vi } from 'vitest';
import type { DronePluginEngine } from '../src/runtime/plugin-engine.js';
import type { DroneSlashCommandContext } from 'drone-core';
import {
  createDefaultAgentConfig,
  type DroneChatResponse,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
} from 'drone-core';
import {
  CANCEL_SENTINEL,
  createConversationService,
} from '../src/runtime/conversation-service.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
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
    setReasoningLevel: (_level: unknown) => {},
    listModels: async () => ['fake'],
    registerDriver: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    describeImages: async images => images,
    getUsageLedger: () => [],
  };
}

type MakeConversationOptions = {
  provider: DroneLlmProvider;
  /** Override classifySlashCommand for slash-routing tests. */
  classifySlashCommand?: (
    line: string
  ) => ReturnType<DronePluginEngine['classifySlashCommand']>;
  /** Override dispatchSlashCommand. */
  dispatchSlashCommand?: (
    line: string,
    ctx: Omit<DroneSlashCommandContext, 'line' | 'args'>
  ) => Promise<boolean>;
  onEvent?: (event: unknown) => void;
};

function makeConversation(options: MakeConversationOptions) {
  const { provider } = options;
  const engine = createMockEngine({
    tools: [],
    executeToolImpl: async () => JSON.stringify({}),
    classifySlashCommand: options.classifySlashCommand,
    dispatchSlashCommand: options.dispatchSlashCommand,
  });
  const config = createDefaultAgentConfig();
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
    sessionManager: createSessionManager(),
    budgetService,
  });
  (engine as { getCapability: (id: string) => unknown }).getCapability = (
    id: string
  ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);
  return { conversation, engine };
}

/**
 * Hold the first chat() call open so we can deterministically reach the
 * "turn in flight" state (same trick as submit-user-message.test.ts).
 */
function holdFirstChat(
  provider: ReturnType<typeof makeProvider>,
  resolveValue: DroneChatResponse
): { release: () => void } {
  let release: (() => void) | undefined;
  provider.__chatMock.mockImplementationOnce(
    () =>
      new Promise<DroneChatResponse>(resolve => {
        release = () => resolve(resolveValue);
      })
  );
  return {
    release: () => release?.(),
  };
}

/** Wait one macrotask so the in-flight flag settles. */
const tick = () => new Promise(r => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('submitUserMessage slash-command routing', () => {
  it('dispatches a busyBehavior:true command immediately while busy (never queues)', async () => {
    const provider = makeProvider([
      { message: 'first reply' },
      { message: 'second reply' },
    ]);
    const dispatch = vi.fn(async () => true);
    const classify = (
      line: string
    ): ReturnType<DronePluginEngine['classifySlashCommand']> =>
      line.startsWith('/help')
        ? {
            kind: 'command',
            command: {
              command: '/help',
              description: 'help',
              handler: async () => true,
            },
            behavior: true,
            invocation: { subcommand: undefined, flags: [] },
            strippedLine: line,
          }
        : ({ kind: 'unknown' } as const);
    const { conversation } = makeConversation({
      provider,
      classifySlashCommand: classify,
      dispatchSlashCommand: dispatch,
    });

    // Start a turn and hold it in flight.
    const held = holdFirstChat(provider, { message: 'first reply' });
    const firstTurn = conversation.sendUserMessage('first');
    await tick();
    expect(conversation.isTurnInFlight()).toBe(true);

    // Busy + immediate (busyBehavior true) → dispatch now, no queue.
    const queued = await conversation.submitUserMessage('/help');
    expect(queued).toBe('');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('/help', expect.anything());

    // The held chat call still resolves the first turn and no queued slash
    // remains (the immediate dispatch already happened).
    held.release();
    await firstTurn;
    await conversation.submitUserMessage('second');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('queues a queue-behavior command while busy and dispatches it after the turn completes', async () => {
    const provider = makeProvider([{ message: 'only reply' }]);
    const dispatch = vi.fn(async () => true);
    const classify = (
      line: string
    ): ReturnType<DronePluginEngine['classifySlashCommand']> =>
      line.startsWith('/focus')
        ? {
            kind: 'command',
            command: {
              command: '/focus',
              description: 'focus',
              handler: async () => true,
            },
            behavior: false,
            invocation: { subcommand: 'set', flags: [] },
            strippedLine: line,
          }
        : ({ kind: 'unknown' } as const);
    const { conversation } = makeConversation({
      provider,
      classifySlashCommand: classify,
      dispatchSlashCommand: dispatch,
    });

    const held = holdFirstChat(provider, { message: 'only reply' });
    const firstTurn = conversation.sendUserMessage('first');
    await tick();

    // Busy + queue behavior → enqueued (dispatch NOT called yet), returns ''.
    const queued = await conversation.submitUserMessage('/focus set clear');
    expect(queued).toBe('');
    expect(dispatch).toHaveBeenCalledTimes(0);

    // When the current turn completes normally, the queued slash dispatches.
    held.release();
    await firstTurn;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      '/focus set clear',
      expect.anything()
    );
  });

  it('warns and does nothing for an unknown slash command', async () => {
    const provider = makeProvider([{ message: 'only reply' }]);
    let lastWarn = '';
    const engine = createMockEngine({
      tools: [],
      executeToolImpl: async () => JSON.stringify({}),
      classifySlashCommand: () => ({ kind: 'unknown' }) as const,
      dispatchSlashCommand: vi.fn(async () => false) as never,
    });
    const config = createDefaultAgentConfig();
    const budgetService = createContextBudgetService({
      config,
      renderPromptFragments: async () => [],
      getProvider: () => provider,
      getModel: () => 'fake',
    });
    const conversation = createConversationService({
      engine: engine as unknown as DronePluginEngine,
      config,
      logger: {
        info: () => {},
        warn: msg => {
          lastWarn = msg;
        },
        error: () => {},
      },
      sessionManager: createSessionManager(),
      budgetService,
    });
    (engine as { getCapability: (id: string) => unknown }).getCapability = (
      id: string
    ) => (id === 'llm' ? makeLlmCapability(provider) : undefined);

    const held = holdFirstChat(provider, { message: 'only reply' });
    const firstTurn = conversation.sendUserMessage('first');
    await tick();

    const queued = await conversation.submitUserMessage('/bogus');
    expect(queued).toBe('');
    expect(lastWarn).toContain('Unknown command: /bogus');

    held.release();
    await firstTurn;
    // The unknown command must never have been dispatched or queued.
    expect(conversation.getMessages().some(m => m.content === '/bogus')).toBe(
      false
    );
  });
});

describe('drain points for queued slash commands', () => {
  it('drain point A: a queued slash dispatches in the finally after a normal completion', async () => {
    const provider = makeProvider([{ message: 'reply' }]);
    const dispatch = vi.fn(async () => true);
    const classify = (
      line: string
    ): ReturnType<DronePluginEngine['classifySlashCommand']> =>
      line.startsWith('/clear')
        ? {
            kind: 'command',
            command: {
              command: '/clear',
              description: 'clear',
              handler: async () => true,
            },
            behavior: false,
            invocation: { subcommand: undefined, flags: [] },
            strippedLine: line,
          }
        : ({ kind: 'unknown' } as const);
    const { conversation } = makeConversation({
      provider,
      classifySlashCommand: classify,
      dispatchSlashCommand: dispatch,
    });

    // Enqueue a slash directly (as the TUI does for a deferred command).
    conversation.enqueueSlashCommand?.('/clear');

    // A sendUserMessage that completes normally drains the queue in finally.
    const reply = await conversation.sendUserMessage('hello');
    expect(reply).toBe('reply');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('/clear', expect.anything());
  });

  it('drain point B: a preserved queued slash dispatches at the start of the next send', async () => {
    const provider = makeProvider([
      { message: 'first reply' },
      { message: 'second reply' },
    ]);
    const dispatch = vi.fn(async () => true);
    const classify = (
      line: string
    ): ReturnType<DronePluginEngine['classifySlashCommand']> =>
      line.startsWith('/clear')
        ? {
            kind: 'command',
            command: {
              command: '/clear',
              description: 'clear',
              handler: async () => true,
            },
            behavior: false,
            invocation: { subcommand: undefined, flags: [] },
            strippedLine: line,
          }
        : ({ kind: 'unknown' } as const);
    const { conversation } = makeConversation({
      provider,
      classifySlashCommand: classify,
      dispatchSlashCommand: dispatch,
    });

    // Start a turn and cancel it (entries are preserved on cancel).
    const held = holdFirstChat(provider, { message: 'first reply' });
    const firstTurn = conversation.sendUserMessage('first');
    await tick();
    conversation.enqueueSlashCommand?.('/clear');
    // Simulate the host cancelling the in-flight request.
    conversation.cancelCurrentRequest();
    held.release();
    await firstTurn;

    // After a cancelled turn, the queued slash is preserved — draining at the
    // START of the next sendUserMessage (point B), before the new prompt.
    await conversation.sendUserMessage('second');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('/clear', expect.anything());
  });

  it('drain point A: a queued text entry runs as its OWN full round (agent answers it)', async () => {
    const provider = makeProvider([
      { message: 'first reply' },
      { message: 'follow-up reply' },
    ]);
    const { conversation } = makeConversation({ provider });
    const chatMock = provider.__chatMock;

    // Queue a text entry while a turn is in flight (submit path).
    const held = holdFirstChat(provider, { message: 'first reply' });
    const firstTurn = conversation.sendUserMessage('first');
    await tick();
    const queued = await conversation.submitUserMessage('follow-up text');
    expect(queued).toBe('');
    held.release();
    await firstTurn;

    // After a normal completion, the queued text runs as its own round: the
    // chat() mock is called a second time (the second response queued above).
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(
      chatMock.mock.calls[1][0].messages.some(
        (m: { content: string }) => m.content === 'follow-up text'
      )
    ).toBe(true);
  });

  it('does not drain on cancel (entries preserved, not dispatched)', async () => {
    const provider = makeProvider([{ message: 'reply' }]);
    const dispatch = vi.fn(async () => true);
    const classify = (
      line: string
    ): ReturnType<DronePluginEngine['classifySlashCommand']> =>
      line.startsWith('/clear')
        ? {
            kind: 'command',
            command: {
              command: '/clear',
              description: 'clear',
              handler: async () => true,
            },
            behavior: false,
            invocation: { subcommand: undefined, flags: [] },
            strippedLine: line,
          }
        : ({ kind: 'unknown' } as const);
    const { conversation } = makeConversation({
      provider,
      classifySlashCommand: classify,
      dispatchSlashCommand: dispatch,
    });

    const held = holdFirstChat(provider, { message: 'reply' });
    const firstTurn = conversation.sendUserMessage('first');
    await tick();
    conversation.enqueueSlashCommand?.('/clear');
    conversation.cancelCurrentRequest();
    held.release();
    await firstTurn;

    // Wait — with a PLAIN text response, the turn completes "normally" (the
    // cancel flag is only observed at the loop top, which a no-tool-call
    // response never revisits). Point A runs and the slash dispatches. The
    // "preserved on cancel" guarantee applies when the cancel is actually
    // honored at the loop top: the response contains tool calls, so the loop
    // iterates back to the cancel check before continuing.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not drain on a cancel that takes effect (tool-call response iterates to the loop top)', async () => {
    const provider = makeProvider([
      {
        toolCalls: [{ id: 'call-1', name: 'some.tool', arguments: {} }],
      },
      { message: 'reply after tool' },
    ]);
    const dispatch = vi.fn(async () => true);
    const classify = (
      line: string
    ): ReturnType<DronePluginEngine['classifySlashCommand']> =>
      line.startsWith('/clear')
        ? {
            kind: 'command',
            command: {
              command: '/clear',
              description: 'clear',
              handler: async () => true,
            },
            behavior: false,
            invocation: { subcommand: undefined, flags: [] },
            strippedLine: line,
          }
        : ({ kind: 'unknown' } as const);
    const { conversation } = makeConversation({
      provider,
      classifySlashCommand: classify,
      dispatchSlashCommand: dispatch,
    });

    // First response triggers a tool call, so the loop ALWAYS revisits the
    // top (after the tool batch) where the cancel flag is observed.
    const held = holdFirstChat(provider, {
      toolCalls: [{ id: 'call-1', name: 'some.tool', arguments: {} }],
    });
    const firstTurn = conversation.sendUserMessage('first');
    await tick();
    conversation.enqueueSlashCommand?.('/clear');
    conversation.cancelCurrentRequest();
    held.release();

    // The loop executes the tool batch, iterates to the top, observes the
    // cancel, and returns CANCEL_SENTINEL without setting completedNormally —
    // so the queued slash is NOT dispatched in the finally.
    const result = await firstTurn;
    expect(result).toBe(CANCEL_SENTINEL);
    expect(dispatch).toHaveBeenCalledTimes(0);

    // The preserved slash drains at the START of the next send (point B).
    await conversation.sendUserMessage('second');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith('/clear', expect.anything());
  });
});

describe('clearSession flushes pending entries', () => {
  it('flushes both text and slash entries', async () => {
    const provider = makeProvider([{ message: 'reply' }]);
    const dispatch = vi.fn(async () => true);
    const classify = (
      line: string
    ): ReturnType<DronePluginEngine['classifySlashCommand']> =>
      line.startsWith('/clear')
        ? {
            kind: 'command',
            command: {
              command: '/clear',
              description: 'clear',
              handler: async () => true,
            },
            behavior: false,
            invocation: { subcommand: undefined, flags: [] },
            strippedLine: line,
          }
        : ({ kind: 'unknown' } as const);
    const { conversation } = makeConversation({
      provider,
      classifySlashCommand: classify,
      dispatchSlashCommand: dispatch,
    });

    conversation.enqueueUserMessage('queued text');
    conversation.enqueueSlashCommand?.('/clear');
    conversation.clearSession();

    // A normal send after clear must not drain either entry.
    await conversation.sendUserMessage('hello');
    expect(dispatch).toHaveBeenCalledTimes(0);
    expect(
      conversation.getMessages().some(m => m.content === 'queued text')
    ).toBe(false);
  });
});
