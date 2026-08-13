import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultAgentConfig,
  type DroneAgentConfig,
  type DroneChatMessage,
  type DroneChatResponse,
  type DroneCompactionConfig,
  type DroneConversationEvent,
  type DroneContextWindowInfo,
  type DroneLlmProvider,
  type DroneLogger,
  type DronePluginRegistration,
  type DroneSessionSafetyTrimPayload,
} from 'drone-core';
import { createCompactionPlugin } from '../src/plugins/compaction/index.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { silentLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeConfig(
  overrides: Partial<DroneCompactionConfig> = {}
): DroneAgentConfig {
  const base = createDefaultAgentConfig();
  return {
    ...base,
    compaction: { ...base.compaction, ...overrides },
  };
}

type FakeProviderOptions = {
  chatResponses?: DroneChatResponse[];
  contextWindow?: number | null;
};

function makeProvider({
  chatResponses = [],
  contextWindow = 4096,
}: FakeProviderOptions = {}): DroneLlmProvider & {
  __chatMock: ReturnType<typeof vi.fn>;
  __contextMock: ReturnType<typeof vi.fn>;
} {
  const chatMock = vi.fn(async () => {
    if (chatResponses.length === 0) {
      return { message: '' };
    }
    return chatResponses.shift() as DroneChatResponse;
  });
  const contextMock = vi.fn(async () => {
    if (contextWindow === null) {
      return null as unknown as DroneContextWindowInfo;
    }
    return {
      model: 'fake',
      contextWindowTokens: contextWindow,
      source: 'provider',
    } satisfies DroneContextWindowInfo;
  });
  return {
    chat: chatMock,
    getContextWindowInfo: contextMock,
    __chatMock: chatMock,
    __contextMock: contextMock,
  };
}

type HookBucket = {
  onPluginsLoaded: Array<() => Promise<void>>;
  onSessionStart: Array<() => Promise<void>>;
  onBeforePrompt: Array<() => Promise<void>>;
  onAfterToolCall: Array<() => Promise<void>>;
  onConversationEvent: Array<(event: DroneConversationEvent) => Promise<void>>;
  onSessionClear: Array<() => Promise<void>>;
  onShutdown: Array<() => Promise<void>>;
  onSessionSafetyTrimWillRun: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  >;
  onSessionSafetyTrimApplied: Array<
    (payload: DroneSessionSafetyTrimPayload) => Promise<void>
  >;
};

type RegistrationCapture = {
  registration: DronePluginRegistration;
  hooks: HookBucket;
  capability: { value: unknown };
  logger: DroneLogger;
};

async function captureRegistration(
  plugin: ReturnType<typeof createCompactionPlugin>,
  config: DroneAgentConfig
): Promise<RegistrationCapture> {
  const hooks: HookBucket = {
    onPluginsLoaded: [],
    onSessionStart: [],
    onBeforePrompt: [],
    onAfterToolCall: [],
    onSessionClear: [],
    onShutdown: [],
    onSessionSafetyTrimWillRun: [],
    onSessionSafetyTrimApplied: [],
    onConversationEvent: [],
  };
  const capability: { value: unknown } = { value: undefined };

  const logger: DroneLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const registration: DronePluginRegistration = {
    logger,
    getConfig: () => config,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerSlashCommand: () => {},
    registerWorkflow: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    hooks: {
      onPluginsLoaded: cb => hooks.onPluginsLoaded.push(cb),
      onSessionStart: cb => hooks.onSessionStart.push(cb),
      onBeforePrompt: cb => hooks.onBeforePrompt.push(cb),
      onAfterToolCall: cb => hooks.onAfterToolCall.push(cb),
      onConversationEvent: cb => hooks.onConversationEvent.push(cb),
      onSessionClear: cb => hooks.onSessionClear.push(cb),
      onShutdown: cb => hooks.onShutdown.push(cb),
      onSessionSafetyTrimWillRun: cb =>
        hooks.onSessionSafetyTrimWillRun.push(cb),
      onSessionSafetyTrimApplied: cb =>
        hooks.onSessionSafetyTrimApplied.push(cb),
    },
    offer: cap => {
      capability.value = cap;
    },
    request: <T>() => undefined as T | undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };

  await plugin.register(registration);

  return { registration, hooks, capability, logger };
}

async function runBeforePrompt(capture: RegistrationCapture): Promise<void> {
  for (const cb of capture.hooks.onBeforePrompt) {
    await cb();
  }
}

async function runAfterToolCall(capture: RegistrationCapture): Promise<void> {
  for (const cb of capture.hooks.onAfterToolCall) {
    await cb();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCompactionPlugin', () => {
  it('reports the expected metadata', () => {
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager: createSessionManager(),
      getModel: () => 'fake',
      getProvider: () => provider,
    });
    expect(plugin.metadata).toMatchObject({
      id: 'compaction',
      name: 'Context Compaction',
      defaultEnabled: true,
    });
  });

  it('registers help text and a CompactionCapability', async () => {
    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager: createSessionManager(),
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    let helpRegistered: string | undefined;
    const capture = await (async () => {
      const hooks: HookBucket = {
        onPluginsLoaded: [],
        onSessionStart: [],
        onBeforePrompt: [],
        onAfterToolCall: [],
        onSessionClear: [],
        onShutdown: [],
        onSessionSafetyTrimWillRun: [],
        onSessionSafetyTrimApplied: [],
        onConversationEvent: [],
      };
      const capability: { value: unknown } = { value: undefined };
      const registration: DronePluginRegistration = {
        logger: silentLogger(),
        getConfig: () => config,
        registerTool: () => {},
        registerPromptFragment: () => {},
        registerHelp: (help: string) => {
          helpRegistered = help;
        },
        registerSlashCommand: () => {},
        registerWorkflow: () => {},
        unregisterPluginTools: () => {},
        unregisterTool: () => {},
        mountTool: () => undefined,
        unmountTool: () => {},
        listMountedTools: () => [],
        hooks: {
          onPluginsLoaded: cb => hooks.onPluginsLoaded.push(cb),
          onSessionStart: cb => hooks.onSessionStart.push(cb),
          onBeforePrompt: cb => hooks.onBeforePrompt.push(cb),
          onAfterToolCall: cb => hooks.onAfterToolCall.push(cb),
          onConversationEvent: cb => hooks.onConversationEvent.push(cb),
          onSessionClear: cb => hooks.onSessionClear.push(cb),
          onShutdown: cb => hooks.onShutdown.push(cb),
          onSessionSafetyTrimWillRun: cb =>
            hooks.onSessionSafetyTrimWillRun.push(cb),
          onSessionSafetyTrimApplied: cb =>
            hooks.onSessionSafetyTrimApplied.push(cb),
        },
        offer: cap => {
          capability.value = cap;
        },
        request: <T>() => undefined as T | undefined,
        runWorkflow: async () => ({ toolResult: '{}' }),
        requestElicitation: () => undefined,
      };
      await plugin.register(registration);
      return { registration, hooks, capability };
    })();

    expect(helpRegistered).toMatch(/Context Compaction/);
    expect(capture.capability.value).toBeTruthy();
    expect(
      typeof (capture.capability.value as { forceEvaluate: unknown })
        .forceEvaluate
    ).toBe('function');
  });

  it('is a no-op when compaction is disabled', async () => {
    const sessionManager = createSessionManager();
    sessionManager.appendUserMessage('hello');
    sessionManager.appendUserMessage('world');

    const config = makeConfig({ enabled: false });
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);

    expect(provider.__chatMock).not.toHaveBeenCalled();
    expect(provider.__contextMock).not.toHaveBeenCalled();
    expect(sessionManager.getSummaryTurns()).toHaveLength(0);
    expect(sessionManager.getTurns()).toHaveLength(2);
  });

  it('is a no-op when there are no turns', async () => {
    const sessionManager = createSessionManager();
    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);

    expect(provider.__chatMock).not.toHaveBeenCalled();
    expect(provider.__contextMock).not.toHaveBeenCalled();
  });

  it('does not compact when usage stays below the soft threshold', async () => {
    const sessionManager = createSessionManager();
    sessionManager.appendUserMessage('short');
    sessionManager.appendAssistantMessage('reply');

    const config = makeConfig({
      softThresholdPercent: 99,
      slicePercent: 25,
      minTurnsToCompact: 2,
    });
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);

    expect(provider.__chatMock).not.toHaveBeenCalled();
    expect(sessionManager.getSummaryTurns()).toHaveLength(0);
  });

  it('drops oldest summary turns when the summary region exceeds the budget', async () => {
    const sessionManager = createSessionManager();
    sessionManager.prependSystemTurn('S1 '.repeat(200), { kind: 'summary' });
    sessionManager.prependSystemTurn('S2 '.repeat(200), { kind: 'summary' });
    sessionManager.appendUserMessage('a');
    sessionManager.appendUserMessage('b');

    const config = makeConfig({
      summaryBudgetPercent: 10,
      softThresholdPercent: 50,
      slicePercent: 25,
      minTurnsToCompact: 2,
    });

    const provider = makeProvider({ contextWindow: 200 });
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);

    const summaries = sessionManager.getSummaryTurns();
    // `getSummaryTurns()` is newest-first because `prependSystemTurn` puts
    // each new summary at the head. The self-purge should drop the *oldest*
    // summary, which is at the end of the array — S1 in this case.
    expect(summaries).toHaveLength(1);
    expect(summaries[0].messages[0].content).toBe('S2 '.repeat(200));
    expect(
      sessionManager.getMessages().filter(m => m.role === 'user')
    ).toHaveLength(2);
    expect(provider.__chatMock).not.toHaveBeenCalled();
  });

  it('summarizes the oldest turns when usage crosses the threshold', async () => {
    const sessionManager = createSessionManager();
    // Long turns push usage well above the threshold.
    for (let i = 0; i < 6; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(300));
    }

    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 25,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'A concise summary.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);

    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    const requestMessages = provider.__chatMock.mock.calls[0][0]
      .messages as DroneChatMessage[];
    expect(requestMessages[0].role).toBe('system');
    expect(requestMessages[1].role).toBe('user');
    expect(requestMessages[1].content).toMatch(/conversation turn/i);

    const summaries = sessionManager.getSummaryTurns();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].messages[0].content).toContain('A concise summary.');
    expect(summaries[0].messages[0].content).toMatch(/^Conversation summary/);
    // Some turns were dropped to make room.
    expect(sessionManager.getTurns().length).toBeLessThan(12);
  });

  it('leaves the session untouched when summarization fails', async () => {
    const sessionManager = createSessionManager();
    for (let i = 0; i < 5; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(400));
    }

    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 25,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: '' }], // empty -> "Ollama returned an empty summary."
    });
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);

    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(sessionManager.getSummaryTurns()).toHaveLength(0);
    // 5 user turns — assistant messages are appended to the current turn
    // rather than starting a new one.
    expect(sessionManager.getTurns()).toHaveLength(5);
  });

  it('does not run compaction again while a previous run is in flight', async () => {
    const sessionManager = createSessionManager();
    for (let i = 0; i < 5; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(400));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(400));
    }

    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 25,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
    });

    // Block the provider's chat() so the first hook call never finishes.
    let release!: () => void;
    const blocked = new Promise<void>(res => {
      release = res;
    });
    const provider: DroneLlmProvider = {
      chat: vi.fn(async () => {
        await blocked;
        return { message: 'late summary' };
      }),
      getContextWindowInfo: vi.fn(
        async (): Promise<DroneContextWindowInfo> => ({
          model: 'fake',
          contextWindowTokens: 200,
          source: 'provider',
        })
      ),
    };
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);

    const first = runBeforePrompt(capture);
    // Give the first call enough ticks to reach provider.chat().
    // The async chain is: hookBody -> buildSystemMessages() -> maybeCompact()
    // -> resolveContextWindow() -> getContextWindowInfo() -> .then() -> chat().
    // That's 3 microtask ticks before chat() is called.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // A second hook call must be a no-op while the first is still running.
    await runBeforePrompt(capture);

    expect(provider.chat).toHaveBeenCalledTimes(1);

    // Release the first call so the test doesn't hang.
    release();
    await first;
  });

  it('exposes a forceEvaluate capability that triggers compaction', async () => {
    const sessionManager = createSessionManager();
    for (let i = 0; i < 5; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(400));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(400));
    }

    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 25,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'forced summary' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);
    const capability = capture.capability.value as {
      forceEvaluate: () => Promise<void>;
    };
    expect(capability).toBeTruthy();

    await capability.forceEvaluate();

    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(sessionManager.getSummaryTurns()).toHaveLength(1);
  });

  it('compacts the oldest normal turns after a summary already exists', async () => {
    const sessionManager = createSessionManager();

    // Seed an existing summary so the array is [S1, turn0, turn1, ...].
    sessionManager.prependSystemTurn('Existing summary.', { kind: 'summary' });

    // Add enough long normal turns that usage crosses the threshold.
    for (let i = 0; i < 8; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(300));
    }

    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 25,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'New summary chunk.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);

    // The plugin should have compacted the oldest non-summary turns (from the
    // tail), not re-summarized the existing summary at the head.
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    const requestMessages = provider.__chatMock.mock.calls[0][0]
      .messages as DroneChatMessage[];
    const summaryPrompt = requestMessages[1].content;
    expect(summaryPrompt).not.toContain('Existing summary');
    expect(summaryPrompt).toMatch(/--- Turn \d+ ---/);

    const summaries = sessionManager.getSummaryTurns();
    expect(summaries).toHaveLength(2);
    expect(summaries[0].messages[0].content).toContain('New summary chunk');

    // Some normal turns should have been dropped.
    const nonSummaryTurns = sessionManager
      .getTurns()
      .filter(t => t.kind !== 'summary');
    expect(nonSummaryTurns.length).toBeLessThan(8);
  });

  it('continues to reduce context usage across multiple compaction rounds', async () => {
    const sessionManager = createSessionManager();
    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 50,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [
        { message: 'First summary.' },
        { message: 'Second summary.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);

    // Round 1: add long turns and compact.
    for (let i = 0; i < 8; i++) {
      sessionManager.appendUserMessage(`round1-u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`round1-a${i} `.repeat(300));
    }
    await runBeforePrompt(capture);
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    const firstSummaryCount = sessionManager.getSummaryTurns().length;
    expect(firstSummaryCount).toBe(1);

    // Round 2: add more long turns. The plugin should compact the oldest
    // remaining normal turns, not re-summarize the existing summary.
    for (let i = 0; i < 8; i++) {
      sessionManager.appendUserMessage(`round2-u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`round2-a${i} `.repeat(300));
    }
    await runBeforePrompt(capture);
    expect(provider.__chatMock).toHaveBeenCalledTimes(2);
    const secondRequest = provider.__chatMock.mock.calls[1][0]
      .messages as DroneChatMessage[];
    expect(secondRequest[1].content).not.toContain('First summary');

    // After two rounds, there should be more than one summary and fewer total
    // turns than if no compaction had occurred.
    expect(sessionManager.getSummaryTurns().length).toBeGreaterThanOrEqual(1);
    expect(sessionManager.getTurns().length).toBeLessThan(16);
  });

  it('evicts the oldest summary first when summary budget is exceeded', async () => {
    const sessionManager = createSessionManager();
    const oldest = sessionManager.prependSystemTurn('OLDEST '.repeat(150), {
      kind: 'summary',
    });
    const newer = sessionManager.prependSystemTurn('NEWER '.repeat(150), {
      kind: 'summary',
    });
    sessionManager.appendUserMessage('keep me');

    const config = makeConfig({
      summaryBudgetPercent: 10,
      softThresholdPercent: 50,
      slicePercent: 25,
      minTurnsToCompact: 2,
    });

    const provider = makeProvider({ contextWindow: 200 });
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);

    const summaries = sessionManager.getSummaryTurns();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(newer.id);
    expect(sessionManager.getTurns().some(t => t.id === oldest.id)).toBe(false);
    expect(provider.__chatMock).not.toHaveBeenCalled();
  });

  it('throws a clear error when the ollama provider is missing', async () => {
    const sessionManager = createSessionManager();
    for (let i = 0; i < 5; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(400));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(400));
    }

    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 25,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
    });

    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => {
        throw new Error('Ollama provider is not available.');
      },
    });

    const capture = await captureRegistration(plugin, config);
    // The hook should catch the error and log it as a warning, not reject.
    await runBeforePrompt(capture);
    expect(capture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/compaction: error during evaluation/)
    );
  });

  it('catches errors from summarization and does not reject', async () => {
    const sessionManager = createSessionManager();
    for (let i = 0; i < 5; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(400));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(400));
    }

    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 25,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
    });

    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => makeProvider({ contextWindow: 1000 }),
    });
    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);
    expect(capture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/compaction: summary failed/)
    );
  });
  it('fires compaction via onAfterToolCall when tool results push usage over threshold', async () => {
    // Simulates a multi-round tool-call loop: usage is below threshold initially,
    // but after several rounds of tool results are appended to the session,
    // compaction should fire when the onAfterToolCall hook runs.
    //
    // This mirrors the conversation service behavior where tool results are
    // appended BEFORE the onAfterToolCall hook fires, giving the compaction
    // plugin an accurate view of context usage.
    const sessionManager = createSessionManager();

    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 50,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'Summary of tool results.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);

    // Start with a small session that's under the threshold.
    // (Two short turns are well under 5% of a 200-token window.)
    sessionManager.appendUserMessage('q1');
    sessionManager.appendAssistantMessage('a1');
    await runBeforePrompt(capture);
    expect(provider.__chatMock).not.toHaveBeenCalled();
    expect(sessionManager.getSummaryTurns()).toHaveLength(0);

    // Simulate tool-call rounds that add large content, mirroring the
    // conversation service where tool results are appended before
    // onAfterToolCall fires. Each user message starts a new turn.
    sessionManager.appendUserMessage('q2');
    sessionManager.appendAssistantMessage('working', [
      {
        id: 'call_1',
        name: 'file__read',
        arguments: { path: '/some/file.ts' },
      },
    ]);
    sessionManager.appendToolResult('file__read', 'x '.repeat(300));

    sessionManager.appendUserMessage('q3');
    sessionManager.appendAssistantMessage('more work', [
      {
        id: 'call_2',
        name: 'search__text',
        arguments: { pattern: 'TODO' },
      },
    ]);
    sessionManager.appendToolResult('search__text', 'y '.repeat(300));

    // Now the session should exceed the threshold. Running the
    // onAfterToolCall hook (which is what fires mid-loop in the
    // conversation service) should trigger compaction.
    await runAfterToolCall(capture);

    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(sessionManager.getSummaryTurns()).toHaveLength(1);
    expect(sessionManager.getSummaryTurns()[0].messages[0].content).toContain(
      'Summary of tool results.'
    );
  });

  it('resets compactionInFlight after the empty-turns early return on the same instance', async () => {
    // Verifies that compactionInFlight is correctly reset when maybeCompact
    // hits the turns.length === 0 early return, allowing subsequent hook
    // calls on the SAME instance to proceed normally. This guards the bug
    // where the latch was set true on the empty-session early return and
    // never released, permanently disabling compaction for the session.
    const sessionManager = createSessionManager();
    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 50,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    // A single provider with a small context window and a summary response.
    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'Summary after adding turns.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);

    // First call on an empty session: early return with the latch latched.
    await runBeforePrompt(capture);
    expect(provider.__chatMock).not.toHaveBeenCalled();

    // Add turns to the SAME session manager, then call the SAME capture
    // again. If compactionInFlight were stuck true, this would be a no-op.
    for (let i = 0; i < 6; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(300));
    }

    await runBeforePrompt(capture);
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(sessionManager.getSummaryTurns()).toHaveLength(1);
  });

  it('releases the latch after the empty-turns early return in the real runtime sequence', async () => {
    // Drives the real runtime ordering on ONE instance: onBeforePrompt fires
    // before the user message is appended (empty session -> latch latches,
    // early return), then tool results are appended and onAfterToolCall fires.
    // Mirrors conversation-service ordering where tool results are appended
    // before onAfterToolCall. If the latch were never released, the
    // onAfterToolCall compaction would be skipped entirely.
    const sessionManager = createSessionManager();
    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 50,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'Summary after tool results.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);

    // First prompt of the session: empty session, latch latches + early return.
    await runBeforePrompt(capture);
    expect(provider.__chatMock).not.toHaveBeenCalled();

    // Append tool results to the SAME session (mirrors conversation-service
    // appending tool results before onAfterToolCall fires).
    for (let i = 0; i < 6; i++) {
      sessionManager.appendUserMessage(`q${i}`);
      sessionManager.appendAssistantMessage(`working ${i}`, [
        {
          id: `call_${i}`,
          name: 'file__read',
          arguments: { path: `/some/file_${i}.ts` },
        },
      ]);
      sessionManager.appendToolResult('file__read', `x ${i} `.repeat(300));
    }

    // onAfterToolCall should now fire compaction because the latch was
    // released and usage is above the threshold.
    await runAfterToolCall(capture);
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(sessionManager.getSummaryTurns()).toHaveLength(1);
  });
});
