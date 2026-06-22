import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultAgentConfig,
  type DroneAgentConfig,
  type DroneChatMessage,
  type DroneChatResponse,
  type DroneCompactionConfig,
  type DroneContextWindowInfo,
  type DroneLlmProvider,
  type DronePluginRegistration,
  type DroneSessionSafetyTrimPayload,
} from 'drone-core';
import { createCompactionPlugin } from '../src/plugins/compaction/index.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { createContextBudgetService } from '../src/runtime/context-budget-service.js';
import type { ContextBudgetService } from '../src/runtime/context-budget-service.js';
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

function makeBudgetService(options: {
  provider: DroneLlmProvider;
  promptFragments?: string[];
  config: DroneAgentConfig;
}): ContextBudgetService {
  const { provider, promptFragments = [], config } = options;
  return createContextBudgetService({
    config,
    renderPromptFragments: async () => promptFragments ?? [],
    getProvider: () => provider,
    getModel: () => 'fake',
  });
}

type HookBucket = {
  onPluginsLoaded: Array<() => Promise<void>>;
  onSessionStart: Array<() => Promise<void>>;
  onBeforePrompt: Array<() => Promise<void>>;
  onAfterToolCall: Array<() => Promise<void>>;
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
    onShutdown: [],
    onSessionSafetyTrimWillRun: [],
    onSessionSafetyTrimApplied: [],
  };
  const capability: { value: unknown } = { value: undefined };

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => config,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerSlashCommand: () => {},
    registerWorkflow: () => {},
    hooks: {
      onPluginsLoaded: cb => hooks.onPluginsLoaded.push(cb),
      onSessionStart: cb => hooks.onSessionStart.push(cb),
      onBeforePrompt: cb => hooks.onBeforePrompt.push(cb),
      onAfterToolCall: cb => hooks.onAfterToolCall.push(cb),
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
}

async function runBeforePrompt(capture: RegistrationCapture): Promise<void> {
  for (const cb of capture.hooks.onBeforePrompt) {
    await cb();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCompactionPlugin', () => {
  it('reports the expected metadata', () => {
    const config = makeConfig();
    const provider = makeProvider();
    const budgetService = makeBudgetService({ provider, config });
    const plugin = createCompactionPlugin({
      budgetService,
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
    const budgetService = makeBudgetService({ provider, config });
    const plugin = createCompactionPlugin({
      budgetService,
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
        onShutdown: [],
        onSessionSafetyTrimWillRun: [],
        onSessionSafetyTrimApplied: [],
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
        hooks: {
          onPluginsLoaded: cb => hooks.onPluginsLoaded.push(cb),
          onSessionStart: cb => hooks.onSessionStart.push(cb),
          onBeforePrompt: cb => hooks.onBeforePrompt.push(cb),
          onAfterToolCall: cb => hooks.onAfterToolCall.push(cb),
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
    const budgetService = makeBudgetService({ provider, config });
    const plugin = createCompactionPlugin({
      budgetService,
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
    const budgetService = makeBudgetService({ provider, config });
    const plugin = createCompactionPlugin({
      budgetService,
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
    const budgetService = makeBudgetService({ provider, config });
    const plugin = createCompactionPlugin({
      budgetService,
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
    const budgetService = makeBudgetService({ provider, config });
    const plugin = createCompactionPlugin({
      budgetService,
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => provider,
    });

    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);

    const summaries = sessionManager.getSummaryTurns();
    // The compaction plugin drops the head of `getSummaryTurns()`, which
    // is the most-recently prepended summary. After the drop, the older
    // summary (S1) survives.
    expect(summaries).toHaveLength(1);
    expect(summaries[0].messages[0].content).toBe('S1 '.repeat(200));
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
    const budgetService = makeBudgetService({ provider, config });
    const plugin = createCompactionPlugin({
      budgetService,
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
    const budgetService = makeBudgetService({ provider, config });
    const plugin = createCompactionPlugin({
      budgetService,
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
    const budgetService = makeBudgetService({ provider, config, promptFragments: [] });
    const plugin = createCompactionPlugin({
      budgetService,
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
    const budgetService = makeBudgetService({ provider, config });
    const plugin = createCompactionPlugin({
      budgetService,
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
      budgetService: { buildSystemMessages: async () => [] } as unknown as ContextBudgetService,
      sessionManager,
      getModel: () => 'fake',
      getProvider: () => {
        throw new Error('Ollama provider is not available.');
      },
    });

    const capture = await captureRegistration(plugin, config);
    await expect(runBeforePrompt(capture)).rejects.toThrow(
      /Ollama provider is not available/
    );
  });
});
