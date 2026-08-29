import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultAgentConfig,
  type DroneAgentConfig,
  type DroneChatMessage,
  type DroneChatResponse,
  type DroneCompactionConfig,
  type DroneConversationEvent,
  type DroneContextWindowInfo,
  type DroneLlmCapability,
  type DroneLlmProvider,
  type DroneLogger,
  type DronePluginRegistration,
  type DroneSessionSafetyTrimPayload,
  type DroneSlashCommand,
  type DroneSlashCommandContext,
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
  slashCommands: DroneSlashCommand[];
  logger: DroneLogger;
  /** Contents queued via `_runtime.queueSystemReminder`, in order. */
  queuedReminders: string[];
  /** Mutable list of canonical tool names returned by listMountedTools(). */
  mountedToolNames: string[];
};

async function captureRegistration(
  plugin: ReturnType<typeof createCompactionPlugin>,
  config: DroneAgentConfig,
  provider?: DroneLlmProvider,
  role?: {
    provider: DroneLlmProvider;
    providerId: string;
    model: string;
    reasoningLevel?: import('drone-core').DroneReasoningLevel;
  },
  describeImagesOverride?: (
    images: import('drone-core').DroneImageContent[]
  ) => Promise<import('drone-core').DroneImageContent[]>
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
  const slashCommands: DroneSlashCommand[] = [];
  const queuedReminders: string[] = [];
  const mountedToolNames: string[] = [];

  // Minimal DroneLlmCapability backed by the test provider, so the plugin's
  // request<DroneLlmCapability>('llm') resolves to a summarizer role wrapping
  // the same provider (active-selection fallback).
  const llmCapability: DroneLlmCapability | undefined = provider
    ? {
        getActiveProvider: () => provider,
        getActiveProviderId: () => 'test-provider',
        getModel: () => 'fake',
        getAvailableProviders: () => [],
        activateProvider: () => {},
        setModel: () => {},
        getReasoningLevel: () => undefined,
        setReasoningLevel: () => {},
        listModels: async () => [],
        registerDriver: () => {},
        registerProvider: () => {},
        unregisterProvider: () => {},
        describeImages: describeImagesOverride ?? (async images => images),
        resolveModelForRole: () =>
          role
            ? {
                provider: role.provider,
                providerId: role.providerId,
                model: role.model,
                ...(role.reasoningLevel
                  ? { reasoningLevel: role.reasoningLevel }
                  : {}),
              }
            : {
                provider,
                providerId: 'test-provider',
                model: 'fake',
              },
      }
    : undefined;

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
    registerSlashCommand: cmd => {
      slashCommands.push(cmd);
    },
    registerWorkflow: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () =>
      mountedToolNames.map(name => ({
        name,
        description: 'test tool',
      })),
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
    request: <T>(pluginId: string) =>
      pluginId === 'llm' && llmCapability
        ? (llmCapability as T)
        : pluginId === 'runtime'
          ? ({
              queueSystemReminder: (content: string) => {
                queuedReminders.push(content);
              },
            } as T)
          : (undefined as T | undefined),
    runWorkflow: async () => ({ toolResult: '{}' }),
    requestElicitation: () => undefined,
  };

  await plugin.register(registration);

  return {
    registration,
    hooks,
    capability,
    slashCommands,
    logger,
    queuedReminders,
    mountedToolNames,
  };
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

async function runSlashCommand(
  capture: RegistrationCapture,
  line: string
): Promise<boolean> {
  const cmd = capture.slashCommands.find(
    c => line === c.command || line.startsWith(c.command + ' ')
  );
  if (!cmd) {
    throw new Error(`No slash command registered for: ${line}`);
  }
  const args = line
    .slice(cmd.command.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const ctx: DroneSlashCommandContext = {
    line,
    args,
    logger: capture.logger,
    engine: {
      executeTool: async () => '',
      runHooks: async () => {},
      getCapability: <T>() => undefined as T | undefined,
    },
    printHelp: () => {},
  };
  return cmd.handler(ctx);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCompactionPlugin', () => {
  it('reports the expected metadata', () => {
    const plugin = createCompactionPlugin({
      sessionManager: createSessionManager(),
    });
    expect(plugin.metadata).toMatchObject({
      id: 'compaction',
      name: 'Context Compaction',
      defaultEnabled: true,
    });
  });

  it('registers help text and a CompactionCapability', async () => {
    const config = makeConfig();
    const plugin = createCompactionPlugin({
      sessionManager: createSessionManager(),
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
    });

    const capture = await captureRegistration(plugin, config, provider);
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
    });

    const capture = await captureRegistration(plugin, config, provider);
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
    });

    const capture = await captureRegistration(plugin, config, provider);
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
    });

    const capture = await captureRegistration(plugin, config, provider);
    await runBeforePrompt(capture);

    const summaries = sessionManager.getSummaryTurns();
    // With the convergence loop, the self-purge keeps dropping summaries until
    // the summary region is under budget. Both S1 and S2 are over budget, so
    // both are dropped. The remaining 2 short user turns are below the soft
    // threshold, so the loop stops without calling the LLM.
    expect(summaries).toHaveLength(0);
    expect(
      sessionManager.getMessages().filter(m => m.role === 'user')
    ).toHaveLength(2);
    expect(provider.__chatMock).not.toHaveBeenCalled();
  });

  it('summarizes the oldest turns when usage crosses the threshold', async () => {
    const sessionManager = createSessionManager();
    // Long turns push usage well above the threshold.
    for (let i = 0; i < 4; i++) {
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
      chatResponses: [
        { message: 'A concise summary.' },
        { message: 'A second summary.' },
        { message: 'A third summary.' },
        { message: 'A fourth summary.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    await runBeforePrompt(capture);

    // The convergence loop keeps compacting until usage is below the soft
    // threshold. 4 rounds = 8 non-summary turns (4 user + 4 assistant).
    // sliceSize 2 compacts 2 per round: 8->6->4->2->0 (4 rounds).
    expect(provider.__chatMock).toHaveBeenCalledTimes(4);
    const requestMessages = provider.__chatMock.mock.calls[0][0]
      .messages as DroneChatMessage[];
    expect(requestMessages[0].role).toBe('system');
    expect(requestMessages[1].role).toBe('user');
    expect(requestMessages[1].content).toMatch(/conversation turn/i);

    const summaries = sessionManager.getSummaryTurns();
    // Four rounds compact all 8 non-summary turns into 4 small summaries,
    // which stay within the 50% summary budget.
    expect(summaries).toHaveLength(4);
    // getSummaryTurns() is oldest-first: summaries appear chronologically.
    expect(summaries[0]!.messages[0].content).toContain('A concise summary.');
    expect(summaries[0]!.messages[0].content).toMatch(/^Conversation summary/);
    // All non-summary turns were compacted away.
    expect(
      sessionManager.getTurns().filter(t => t.kind !== 'summary')
    ).toHaveLength(0);
  });

  it('keeps summaries in chronological order in the message stream', async () => {
    // Regression test: summaries used to reach the LLM newest-first because
    // prependSystemTurn unshifted each summary in front of the previous ones.
    // getMessages() must present the summary block oldest-first.
    const sessionManager = createSessionManager();
    for (let i = 0; i < 4; i++) {
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
      chatResponses: [
        { message: 'Chrono first.' },
        { message: 'Chrono second.' },
        { message: 'Chrono third.' },
        { message: 'Chrono fourth.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    await runBeforePrompt(capture);

    const summaryContents = sessionManager
      .getMessages()
      .map(m => m.content)
      .filter(content => content.startsWith('Conversation summary'));
    expect(summaryContents).toHaveLength(4);
    expect(summaryContents[0]).toContain('Chrono first.');
    expect(summaryContents[1]).toContain('Chrono second.');
    expect(summaryContents[2]).toContain('Chrono third.');
    expect(summaryContents[3]).toContain('Chrono fourth.');
  });

  it('converges to below the soft threshold in a single maybeCompact call', async () => {
    // Regression test for Bug #4: maybeCompact was single-shot, so if usage
    // stayed above the threshold after one round, nothing happened until the
    // next hook fire. The convergence loop must keep compacting within a
    // single call until usage is below the soft threshold.
    const sessionManager = createSessionManager();
    for (let i = 0; i < 12; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(300));
    }

    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 25,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 100,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [
        { message: 'S1.' },
        { message: 'S2.' },
        { message: 'S3.' },
        { message: 'S4.' },
        { message: 'S5.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    await runBeforePrompt(capture);

    // 12 rounds = 24 non-summary turns. sliceSize recomputed each round:
    // 24->6, 18->4, 14->3, 11->2, 9->2 across the 5-iteration cap, leaving
    // 7 non-summary turns (convergence can't finish before the cap).
    expect(provider.__chatMock).toHaveBeenCalledTimes(5);
    expect(
      sessionManager.getTurns().filter(t => t.kind !== 'summary')
    ).toHaveLength(7);
  });

  it('computes sliceSize against the non-summary turn count (death spiral fix)', async () => {
    // Regression test for Bug #1: sliceSize was computed against turns.length
    // (which includes summaries), so compaction progressively weakened as
    // summaries accumulated. With 2 summaries + 8 normal turns and
    // slicePercent=50, sliceSize must be 4 (50% of 8), not 5 (50% of 10).
    const sessionManager = createSessionManager();
    sessionManager.prependSystemTurn('S1 '.repeat(200), { kind: 'summary' });
    sessionManager.prependSystemTurn('S2 '.repeat(200), { kind: 'summary' });
    for (let i = 0; i < 8; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(300));
    }

    const config = makeConfig({
      softThresholdPercent: 5,
      slicePercent: 50,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'S3.' }, { message: 'S4.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    await runBeforePrompt(capture);

    // The first transcript must contain exactly 8 turns (50% of the 16
    // non-summary turns: 8 user + 8 assistant).
    const firstRequest = provider.__chatMock.mock.calls[0][0]
      .messages as DroneChatMessage[];
    const turnCount = (firstRequest[1].content.match(/--- Turn \d+ ---/g) ?? [])
      .length;
    expect(turnCount).toBe(8);
  });

  it('caps the convergence loop at a bounded number of iterations', async () => {
    // Regression test for the max-iteration cap: if each round only removes a
    // tiny fraction, the loop must terminate after a bounded number of
    // iterations rather than running forever.
    const sessionManager = createSessionManager();
    for (let i = 0; i < 20; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(300));
    }

    const config = makeConfig({
      softThresholdPercent: 1,
      slicePercent: 10,
      minTurnsToCompact: 1,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [
        { message: 'S1.' },
        { message: 'S2.' },
        { message: 'S3.' },
        { message: 'S4.' },
        { message: 'S5.' },
        { message: 'S6.' },
        { message: 'S7.' },
        { message: 'S8.' },
        { message: 'S9.' },
        { message: 'S10.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    await runBeforePrompt(capture);

    // The loop must stop after at most 5 iterations (the hard cap), even
    // though usage is still above the threshold.
    expect(provider.__chatMock.mock.calls.length).toBeLessThanOrEqual(5);
    // Some non-summary turns should remain (the loop did not compact them all).
    expect(
      sessionManager.getTurns().filter(t => t.kind !== 'summary').length
    ).toBeGreaterThan(0);
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
    });

    const capture = await captureRegistration(plugin, config, provider);
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
    });

    const capture = await captureRegistration(plugin, config, provider);

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
      chatResponses: [
        { message: 'forced summary' },
        { message: 'forced summary 2' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const capability = capture.capability.value as {
      forceEvaluate: () => Promise<void>;
    };
    expect(capability).toBeTruthy();

    await capability.forceEvaluate();

    // forceEvaluate caps at a single forced round (maxIterations: 1), so it
    // compacts one slice and stops even though non-summary turns remain above
    // the soft threshold.
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(sessionManager.getSummaryTurns()).toHaveLength(1);
    expect(
      sessionManager.getTurns().filter(t => t.kind !== 'summary').length
    ).toBeGreaterThan(0);
  });

  it('compacts the oldest normal turns after a summary already exists', async () => {
    const sessionManager = createSessionManager();

    // Seed an existing summary so the array is [S1, turn0, turn1, ...].
    sessionManager.prependSystemTurn('Existing summary.', { kind: 'summary' });

    // Add enough long normal turns that usage crosses the threshold.
    for (let i = 0; i < 4; i++) {
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
      chatResponses: [
        { message: 'New summary chunk.' },
        { message: 'New summary chunk 2.' },
        { message: 'New summary chunk 3.' },
        { message: 'New summary chunk 4.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    await runBeforePrompt(capture);

    // The plugin should have compacted the oldest non-summary turns (from the
    // tail), not re-summarized the existing summary at the head. 4 rounds =
    // 8 non-summary turns, sliceSize 2 -> 4 rounds to compact all.
    expect(provider.__chatMock).toHaveBeenCalledTimes(4);
    const requestMessages = provider.__chatMock.mock.calls[0][0]
      .messages as DroneChatMessage[];
    const summaryPrompt = requestMessages[1].content;
    expect(summaryPrompt).not.toContain('Existing summary');
    expect(summaryPrompt).toMatch(/--- Turn \d+ ---/);

    const summaries = sessionManager.getSummaryTurns();
    expect(summaries).toHaveLength(5);
    // Oldest-first: the seeded summary stays at index 0; new chunks append.
    expect(summaries[0].messages[0].content).toContain('Existing summary.');
    expect(summaries.at(-1)!.messages[0].content).toContain(
      'New summary chunk'
    );

    // All normal turns should have been compacted away.
    const nonSummaryTurns = sessionManager
      .getTurns()
      .filter(t => t.kind !== 'summary');
    expect(nonSummaryTurns.length).toBe(0);
  });

  it('pins BOTH ends: summarizes the oldest non-summary turns, never the newest', async () => {
    // Regression test for the bug where compaction sliced the array tail and
    // summarized the NEWEST non-summary turns instead of the OLDEST. The array
    // is [S, u0, u1, ..., u5] (summary prepended at head, normal turns appended
    // at tail). Compaction must drop the oldest normal turns (u0, u1, ...) and
    // leave the newest (u5) intact.
    const sessionManager = createSessionManager();

    // Seed a summary so the head is a summary turn.
    sessionManager.prependSystemTurn('Seeded summary.', { kind: 'summary' });

    // Distinct, identifiable content per turn so we can assert exactly which
    // turns were summarized and which survived.
    for (let i = 0; i < 4; i++) {
      sessionManager.appendUserMessage(`oldest-u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`oldest-a${i} `.repeat(300));
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
      chatResponses: [
        { message: 'Pinned summary.' },
        { message: 'Pinned summary 2.' },
        { message: 'Pinned summary 3.' },
        { message: 'Pinned summary 4.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    await runBeforePrompt(capture);

    // 4 rounds = 8 non-summary turns, sliceSize 2 -> 4 rounds to compact all.
    expect(provider.__chatMock).toHaveBeenCalledTimes(4);
    const requestMessages = provider.__chatMock.mock.calls[0][0]
      .messages as DroneChatMessage[];
    const summaryPrompt = requestMessages[1].content;

    // The summary transcript must contain the OLDEST non-summary turns...
    expect(summaryPrompt).toContain('oldest-u0');
    expect(summaryPrompt).toContain('oldest-a0');
    // ...and must NOT contain the NEWEST non-summary turns.
    expect(summaryPrompt).not.toContain('oldest-u3');
    expect(summaryPrompt).not.toContain('oldest-u2');

    // With convergence, all non-summary turns are eventually compacted.
    expect(
      sessionManager.getTurns().filter(t => t.kind !== 'summary')
    ).toHaveLength(0);
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
        { message: 'Third summary.' },
        { message: 'Fourth summary.' },
        { message: 'Fifth summary.' },
        { message: 'Sixth summary.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);

    // Round 1: add long turns and compact.
    for (let i = 0; i < 4; i++) {
      sessionManager.appendUserMessage(`round1-u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`round1-a${i} `.repeat(300));
    }
    await runBeforePrompt(capture);
    // Round 1: 8 non-summary turns, slicePercent 50. Convergence compacts
    // 4, then 2, then 2 turns until all are gone: 3 rounds.
    expect(provider.__chatMock).toHaveBeenCalledTimes(3);
    expect(sessionManager.getSummaryTurns().length).toBe(3);

    // Round 2: add more long turns. The plugin should compact the oldest
    // remaining normal turns, not re-summarize the existing summary.
    for (let i = 0; i < 4; i++) {
      sessionManager.appendUserMessage(`round2-u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`round2-a${i} `.repeat(300));
    }
    await runBeforePrompt(capture);
    // Round 2 compacts another 8 turns in 3 rounds, for 6 total.
    expect(provider.__chatMock).toHaveBeenCalledTimes(6);
    const secondRequest = provider.__chatMock.mock.calls[3][0]
      .messages as DroneChatMessage[];
    expect(secondRequest[1].content).not.toContain('First summary');

    // After two rounds, all non-summary turns are compacted away. The summary
    // budget self-purge drops one summary during round 2, leaving 5.
    expect(sessionManager.getSummaryTurns().length).toBe(5);
    expect(
      sessionManager.getTurns().filter(t => t.kind !== 'summary')
    ).toHaveLength(0);
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
    });

    const capture = await captureRegistration(plugin, config, provider);
    await runBeforePrompt(capture);

    const summaries = sessionManager.getSummaryTurns();
    // With the convergence loop, the self-purge keeps dropping summaries until
    // the summary region is under budget. Both OLDEST and NEWER are over
    // budget, so both are dropped. Only 1 non-summary turn remains, which is
    // below minTurnsToCompact, so the loop stops without calling the LLM.
    expect(summaries).toHaveLength(0);
    expect(sessionManager.getTurns().some(t => t.id === oldest.id)).toBe(false);
    expect(sessionManager.getTurns().some(t => t.id === newer.id)).toBe(false);
    expect(provider.__chatMock).not.toHaveBeenCalled();
  });

  it('warns and skips when the LLM broker is unavailable', async () => {
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
    });

    // No provider passed → request('llm') returns undefined → warn + skip.
    const capture = await captureRegistration(plugin, config);
    await runBeforePrompt(capture);
    expect(capture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/LLM broker capability unavailable/)
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
    });
    // Provider returns an empty message → summary throws → logged as failure.
    const capture = await captureRegistration(
      plugin,
      config,
      makeProvider({ contextWindow: 1000 })
    );
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
      softThresholdPercent: 70,
      slicePercent: 50,
      minTurnsToCompact: 4,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'Summary of tool results.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);

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
      chatResponses: [
        { message: 'Summary after adding turns.' },
        { message: 'Summary after adding turns 2.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);

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
    // 6 rounds = 12 non-summary turns. sliceSize 6, then 3, then 3 across
    // 3 rounds; the 3rd chat returns an empty summary (no more responses
    // queued), ending the loop after 3 calls.
    expect(provider.__chatMock).toHaveBeenCalledTimes(3);
    expect(sessionManager.getSummaryTurns()).toHaveLength(2);
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
      chatResponses: [
        { message: 'Summary after tool results.' },
        { message: 'Summary after tool results 2.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);

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
    // 6 rounds = 12 non-summary turns. sliceSize 6, then 3, then 3 across
    // 3 rounds; the 3rd chat returns an empty summary (no more responses
    // queued), ending the loop after 3 calls.
    expect(provider.__chatMock).toHaveBeenCalledTimes(3);
    expect(sessionManager.getSummaryTurns()).toHaveLength(2);
  });
});

it('emits compaction events when emitEvent is provided', async () => {
  const sessionManager = createSessionManager();
  for (let i = 0; i < 4; i++) {
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
    chatResponses: [
      { message: 'A concise summary.' },
      { message: 'A second summary.' },
      { message: 'A third summary.' },
      { message: 'A fourth summary.' },
    ],
  });
  const emitEvent = vi.fn();
  const plugin = createCompactionPlugin({
    sessionManager,
    emitEvent,
  });

  const capture = await captureRegistration(plugin, config, provider);
  await runBeforePrompt(capture);

  // 4 rounds = 8 non-summary turns; sliceSize 2 compacts 2 per round for 4
  // rounds, each emitting a started + completed event.
  expect(emitEvent).toHaveBeenCalledTimes(8);
  expect(emitEvent).toHaveBeenNthCalledWith(1, {
    kind: 'compaction',
    message: expect.stringMatching(/Compacting/),
    status: 'started',
  });
  expect(emitEvent).toHaveBeenNthCalledWith(2, {
    kind: 'compaction',
    message: expect.stringMatching(/Compacted/),
    status: 'completed',
  });
  expect(emitEvent).toHaveBeenNthCalledWith(3, {
    kind: 'compaction',
    message: expect.stringMatching(/Compacting/),
    status: 'started',
  });
  expect(emitEvent).toHaveBeenNthCalledWith(4, {
    kind: 'compaction',
    message: expect.stringMatching(/Compacted/),
    status: 'completed',
  });
  expect(emitEvent).toHaveBeenNthCalledWith(5, {
    kind: 'compaction',
    message: expect.stringMatching(/Compacting/),
    status: 'started',
  });
  expect(emitEvent).toHaveBeenNthCalledWith(6, {
    kind: 'compaction',
    message: expect.stringMatching(/Compacted/),
    status: 'completed',
  });
});

it('emits a failed compaction event when summarization fails', async () => {
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
    chatResponses: [{ message: '' }],
  });
  const emitEvent = vi.fn();
  const plugin = createCompactionPlugin({
    sessionManager,
    emitEvent,
  });

  const capture = await captureRegistration(plugin, config, provider);
  await runBeforePrompt(capture);

  expect(emitEvent).toHaveBeenCalledTimes(2);
  expect(emitEvent).toHaveBeenNthCalledWith(1, {
    kind: 'compaction',
    message: expect.stringMatching(/Compacting/),
    status: 'started',
  });
  expect(emitEvent).toHaveBeenNthCalledWith(2, {
    kind: 'compaction',
    message: expect.stringMatching(/Compaction failed/),
    status: 'failed',
  });
});

it('emits a compaction event when self-purging old summaries', async () => {
  const sessionManager = createSessionManager();
  sessionManager.prependSystemTurn('S1 '.repeat(200), { kind: 'summary' });
  sessionManager.appendUserMessage('a');
  sessionManager.appendUserMessage('b');

  const config = makeConfig({
    summaryBudgetPercent: 10,
    softThresholdPercent: 50,
    slicePercent: 25,
    minTurnsToCompact: 2,
  });

  const provider = makeProvider({ contextWindow: 200 });
  const emitEvent = vi.fn();
  const plugin = createCompactionPlugin({
    sessionManager,
    emitEvent,
  });

  const capture = await captureRegistration(plugin, config, provider);
  await runBeforePrompt(capture);

  expect(emitEvent).toHaveBeenCalledTimes(1);
  expect(emitEvent).toHaveBeenCalledWith({
    kind: 'compaction',
    message: 'Dropped oldest summary turn',
    status: 'completed',
  });
});

describe('CompactionCapability extensions', () => {
  it('forceEvaluateAll compacts all non-summary turns in one call', async () => {
    const sessionManager = createSessionManager();
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
      chatResponses: [
        { message: 'S1.' },
        { message: 'S2.' },
        { message: 'S3.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const capability = capture.capability.value as {
      forceEvaluateAll: () => Promise<void>;
    };

    await capability.forceEvaluateAll();

    // With slicePercent overridden to 100, all 6 non-summary turns are
    // compacted in a single round.
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(sessionManager.getSummaryTurns()).toHaveLength(1);
    expect(
      sessionManager.getTurns().filter(t => t.kind !== 'summary')
    ).toHaveLength(0);
  });

  it('getStatus returns correct counts and summary previews', async () => {
    const sessionManager = createSessionManager();
    sessionManager.prependSystemTurn('Summary one content.', {
      kind: 'summary',
    });
    sessionManager.prependSystemTurn('Summary two content.', {
      kind: 'summary',
    });
    sessionManager.appendUserMessage('hello');
    sessionManager.appendUserMessage('world');

    const config = makeConfig({
      softThresholdPercent: 50,
      slicePercent: 25,
      minTurnsToCompact: 2,
    });

    const provider = makeProvider({ contextWindow: 4096 });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const capability = capture.capability.value as {
      getStatus: () => Promise<{
        enabled: boolean;
        config: DroneCompactionConfig;
        turns: {
          total: number;
          nonSummary: number;
          summary: number;
          oldestNonSummaryIndex: number | null;
        };
        contextWindow: {
          softThresholdPercent: number;
          currentUsagePercent: number;
          summaryBudgetPercent: number;
          currentSummaryPercent: number;
        };
        summaries: Array<{
          id: string;
          preview: string;
          tokenCount: number;
        }>;
      }>;
    };

    const status = await capability.getStatus();
    expect(status.enabled).toBe(true);
    expect(status.turns.total).toBe(4);
    expect(status.turns.nonSummary).toBe(2);
    expect(status.turns.summary).toBe(2);
    expect(status.turns.oldestNonSummaryIndex).toBe(2);
    expect(status.contextWindow.softThresholdPercent).toBe(50);
    expect(status.summaries).toHaveLength(2);
    // Oldest-first: the first-prepended summary is listed first.
    expect(status.summaries[0].preview).toContain('Summary one content');
    expect(status.summaries[0].tokenCount).toBeGreaterThan(0);
    expect(status.summaries.at(-1)!.preview).toContain('Summary two content');
  });

  it('dropSummary removes a specific summary turn by id', async () => {
    const sessionManager = createSessionManager();
    const s1 = sessionManager.prependSystemTurn('Summary one.', {
      kind: 'summary',
    });
    const s2 = sessionManager.prependSystemTurn('Summary two.', {
      kind: 'summary',
    });
    sessionManager.appendUserMessage('hello');

    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const capability = capture.capability.value as {
      dropSummary: (id: string) => Promise<boolean>;
    };

    const ok = await capability.dropSummary(s1.id);
    expect(ok).toBe(true);
    expect(sessionManager.getSummaryTurns()).toHaveLength(1);
    expect(sessionManager.getSummaryTurns()[0].id).toBe(s2.id);

    const notFound = await capability.dropSummary('nonexistent');
    expect(notFound).toBe(false);
  });

  it('dropAllSummaries removes all summary turns', async () => {
    const sessionManager = createSessionManager();
    sessionManager.prependSystemTurn('Summary one.', { kind: 'summary' });
    sessionManager.prependSystemTurn('Summary two.', { kind: 'summary' });
    sessionManager.appendUserMessage('hello');

    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const capability = capture.capability.value as {
      dropAllSummaries: () => Promise<number>;
    };

    const dropped = await capability.dropAllSummaries();
    expect(dropped).toBe(2);
    expect(sessionManager.getSummaryTurns()).toHaveLength(0);
    expect(sessionManager.getTurns()).toHaveLength(1);
  });

  it('dropOldestSummaries removes the oldest N summary turns', async () => {
    const sessionManager = createSessionManager();
    const s1 = sessionManager.prependSystemTurn('Oldest summary.', {
      kind: 'summary',
    });
    const s2 = sessionManager.prependSystemTurn('Middle summary.', {
      kind: 'summary',
    });
    const s3 = sessionManager.prependSystemTurn('Newest summary.', {
      kind: 'summary',
    });
    sessionManager.appendUserMessage('hello');

    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const capability = capture.capability.value as {
      dropOldestSummaries: (count: number) => Promise<number>;
    };

    const dropped = await capability.dropOldestSummaries(2);
    expect(dropped).toBe(2);
    const remaining = sessionManager.getSummaryTurns();
    expect(remaining).toHaveLength(1);
    // Oldest-first: dropping the 2 oldest leaves the newest at index 0.
    expect(remaining[0].id).toBe(s3.id);
    expect(sessionManager.getTurns().some(t => t.id === s1.id)).toBe(false);
    expect(sessionManager.getTurns().some(t => t.id === s2.id)).toBe(false);
  });
});

describe('/compact slash command', () => {
  it('registers a /compact slash command', async () => {
    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager: createSessionManager(),
    });

    const capture = await captureRegistration(plugin, config, provider);
    expect(capture.slashCommands.some(c => c.command === '/compact')).toBe(
      true
    );
  });

  it('shows a warning when there are not enough non-summary turns', async () => {
    const sessionManager = createSessionManager();
    sessionManager.appendUserMessage('hello');

    const config = makeConfig({
      minTurnsToCompact: 2,
    });
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact');
    expect(handled).toBe(true);
    expect(capture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Only 1 non-summary turn/)
    );
  });

  it('compacts via /compact', async () => {
    const sessionManager = createSessionManager();
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
      chatResponses: [
        { message: 'S1.' },
        { message: 'S2.' },
        { message: 'S3.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact');
    expect(handled).toBe(true);
    expect(provider.__chatMock).toHaveBeenCalled();
    expect(sessionManager.getSummaryTurns().length).toBeGreaterThan(0);
    expect(capture.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Compacted oldest non-summary turns/)
    );
  });

  it('compacts via /compact exactly one full round', async () => {
    // Regression test: /compact (forceEvaluate) must stop after exactly one
    // forced slice instead of running the full convergence loop (which would
    // slice-and-summarize until every non-summary turn was consumed).
    const sessionManager = createSessionManager();
    for (let i = 0; i < 10; i++) {
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

    // Enough responses that any full convergence run would eat far more than
    // one round; we assert only one was used.
    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [
        { message: 'S1.' },
        { message: 'S2.' },
        { message: 'S3.' },
        { message: 'S4.' },
        { message: 'S5.' },
      ],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact');
    expect(handled).toBe(true);

    // /compact performs exactly one forced round.
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    // A summary was created, but non-summary turns remain (it did NOT converge
    // to zero).
    expect(sessionManager.getSummaryTurns()).toHaveLength(1);
    expect(
      sessionManager.getTurns().filter(t => t.kind !== 'summary').length
    ).toBeGreaterThan(0);
  });

  it('compacts via /compact even when usage is below the soft threshold', async () => {
    // Regression test for the manual-force bug: `maybeCompact` broke early on
    // `usagePercent <= softThreshold` even when `force: true`, so `/compact`
    // printed success but never compacted a session already under the soft
    // threshold. Manual compaction must proceed regardless of current usage.
    const sessionManager = createSessionManager();
    for (let i = 0; i < 4; i++) {
      sessionManager.appendUserMessage(`u${i}`);
      sessionManager.appendAssistantMessage(`a${i}`);
    }

    // Very high soft threshold + large context window ⇒ usage stays well
    // below the threshold, which is the exact condition that previously
    // caused `/compact` to bail out before compacting anything.
    const config = makeConfig({
      softThresholdPercent: 99,
      slicePercent: 25,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    const provider = makeProvider({
      contextWindow: 4096,
      chatResponses: [{ message: 'S1.' }, { message: 'S2.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact');
    expect(handled).toBe(true);
    expect(provider.__chatMock).toHaveBeenCalled();
    expect(sessionManager.getSummaryTurns().length).toBeGreaterThan(0);
  });

  it('compacts all via /compact --all', async () => {
    const sessionManager = createSessionManager();
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
      chatResponses: [{ message: 'S1.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact --all');
    expect(handled).toBe(true);
    expect(provider.__chatMock).toHaveBeenCalledTimes(1);
    expect(
      sessionManager.getTurns().filter(t => t.kind !== 'summary')
    ).toHaveLength(0);
    expect(capture.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Compacted ALL non-summary turns/)
    );
  });

  it('shows summaries via /compact show', async () => {
    const sessionManager = createSessionManager();
    sessionManager.prependSystemTurn('Summary one content.', {
      kind: 'summary',
    });
    sessionManager.appendUserMessage('hello');

    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact show');
    expect(handled).toBe(true);
    expect(capture.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Compaction summaries/)
    );
    expect(capture.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Summary one content/)
    );
  });

  it('shows a message when there are no summaries via /compact show', async () => {
    const sessionManager = createSessionManager();
    sessionManager.appendUserMessage('hello');

    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact show');
    expect(handled).toBe(true);
    expect(capture.logger.info).toHaveBeenCalledWith(
      'No compaction summaries in current context'
    );
  });

  it('drops a summary by id via /compact drop <id>', async () => {
    const sessionManager = createSessionManager();
    const s1 = sessionManager.prependSystemTurn('Summary one.', {
      kind: 'summary',
    });
    sessionManager.appendUserMessage('hello');

    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, `/compact drop ${s1.id}`);
    expect(handled).toBe(true);
    expect(sessionManager.getSummaryTurns()).toHaveLength(0);
    expect(capture.logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/Dropped summary/)
    );
  });

  it('drops all summaries via /compact drop all', async () => {
    const sessionManager = createSessionManager();
    sessionManager.prependSystemTurn('Summary one.', { kind: 'summary' });
    sessionManager.prependSystemTurn('Summary two.', { kind: 'summary' });
    sessionManager.appendUserMessage('hello');

    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact drop all');
    expect(handled).toBe(true);
    expect(sessionManager.getSummaryTurns()).toHaveLength(0);
    expect(capture.logger.info).toHaveBeenCalledWith(
      'Dropped 2 summary turn(s)'
    );
  });

  it('drops N oldest summaries via /compact drop N', async () => {
    const sessionManager = createSessionManager();
    sessionManager.prependSystemTurn('Summary one.', { kind: 'summary' });
    sessionManager.prependSystemTurn('Summary two.', { kind: 'summary' });
    sessionManager.prependSystemTurn('Summary three.', { kind: 'summary' });
    sessionManager.appendUserMessage('hello');

    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact drop 2');
    expect(handled).toBe(true);
    expect(sessionManager.getSummaryTurns()).toHaveLength(1);
    expect(capture.logger.info).toHaveBeenCalledWith(
      'Dropped 2 oldest summary turn(s)'
    );
  });

  it('warns on unknown subcommand', async () => {
    const config = makeConfig();
    const provider = makeProvider();
    const plugin = createCompactionPlugin({
      sessionManager: createSessionManager(),
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact bogus');
    expect(handled).toBe(true);
    expect(capture.logger.warn).toHaveBeenCalledWith(
      'Unknown compact subcommand: bogus'
    );
  });

  it('warns but still compacts when compaction is disabled in config', async () => {
    const sessionManager = createSessionManager();
    for (let i = 0; i < 6; i++) {
      sessionManager.appendUserMessage(`u${i} `.repeat(300));
      sessionManager.appendAssistantMessage(`a${i} `.repeat(300));
    }

    const config = makeConfig({
      enabled: false,
      softThresholdPercent: 5,
      slicePercent: 25,
      minTurnsToCompact: 2,
      summaryMaxTokens: 200,
      summaryBudgetPercent: 50,
    });

    const provider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'S1.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
    });

    const capture = await captureRegistration(plugin, config, provider);
    const handled = await runSlashCommand(capture, '/compact');
    expect(handled).toBe(true);
    expect(capture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Compaction is disabled in config/)
    );
    expect(provider.__chatMock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Pre-compaction nudge
// ---------------------------------------------------------------------------

describe('pre-compaction nudge', () => {
  const WINDOW = 10000;
  const SOFT = 50;
  const MARGIN = 10;
  // Band in absolute tokens against a 10k window: [4000, 5000].
  const BAND_FLOOR_TOKENS = ((SOFT - MARGIN) * WINDOW) / 100;

  function makeNudgeConfig(
    overrides: Partial<DroneCompactionConfig> = {}
  ): DroneAgentConfig {
    return makeConfig({
      softThresholdPercent: SOFT,
      nudgeMarginPercent: MARGIN,
      minTurnsToCompact: 2,
      slicePercent: 25,
      summaryBudgetPercent: 50,
      ...overrides,
    });
  }

  function systemPromptTokens(config: DroneAgentConfig): number {
    // Mirrors estimateMessageTokens: 6 overhead + ceil(chars / 4).
    return 6 + Math.ceil(config.systemPrompt.length / 4);
  }

  /** Tracks estimated session-token growth using the estimator's formula. */
  function makeTracker(config: DroneAgentConfig): {
    total: number;
    add: (chars: number) => void;
    resetTo: (tokens: number) => void;
  } {
    let total = systemPromptTokens(config);
    return {
      get total() {
        return total;
      },
      add(chars: number) {
        total += 6 + Math.ceil(chars / 4);
      },
      resetTo(tokens: number) {
        total = tokens;
      },
    };
  }

  function noticeEvents(emitEvent: ReturnType<typeof vi.fn>): unknown[] {
    return emitEvent.mock.calls
      .map(([event]) => event)
      .filter(event => event.kind === 'notice');
  }

  it('fires once when usage enters the band, stays quiet inside it', async () => {
    const config = makeNudgeConfig();
    const tracker = makeTracker(config);
    const sessionManager = createSessionManager();
    const emitEvent = vi.fn();
    const provider = makeProvider({ contextWindow: WINDOW });
    const plugin = createCompactionPlugin({
      sessionManager,
      emitEvent,
    });

    const capture = await captureRegistration(plugin, config, provider);

    // Grow to just below the band floor and evaluate: nothing yet.
    while (tracker.total < BAND_FLOOR_TOKENS - 260) {
      sessionManager.appendUserMessage('x'.repeat(960));
      tracker.add(960);
    }
    await runBeforePrompt(capture);
    expect(capture.queuedReminders).toHaveLength(0);
    expect(noticeEvents(emitEvent)).toHaveLength(0);

    // Cross into the band with one more chunk: exactly one fire.
    sessionManager.appendUserMessage('x'.repeat(1200));
    tracker.add(1200);
    expect(tracker.total).toBeGreaterThanOrEqual(BAND_FLOOR_TOKENS);
    expect(tracker.total).toBeLessThanOrEqual((SOFT * WINDOW) / 100);
    await runBeforePrompt(capture);
    expect(capture.queuedReminders).toHaveLength(1);
    expect(noticeEvents(emitEvent)).toHaveLength(1);

    // Further growth inside the band: still exactly one.
    sessionManager.appendUserMessage('x'.repeat(1200));
    await runBeforePrompt(capture);
    await runAfterToolCall(capture);
    expect(capture.queuedReminders).toHaveLength(1);
    expect(noticeEvents(emitEvent)).toHaveLength(1);
  });

  it('does not warn on overshoot: usage beyond the soft threshold skips the nudge', async () => {
    const config = makeNudgeConfig();
    const tracker = makeTracker(config);
    const sessionManager = createSessionManager();
    const emitEvent = vi.fn();
    // Empty summary responses make every summarization attempt fail, so
    // usage stays above the soft threshold and no later convergence
    // iteration can re-enter the band during this evaluation.
    const provider = makeProvider({ contextWindow: WINDOW });
    const plugin = createCompactionPlugin({
      sessionManager,
      emitEvent,
    });

    const capture = await captureRegistration(plugin, config, provider);

    while (tracker.total < BAND_FLOOR_TOKENS - 260) {
      sessionManager.appendUserMessage('x'.repeat(960));
      tracker.add(960);
    }
    // One giant jump clean past the soft threshold.
    sessionManager.appendUserMessage('x'.repeat(8000));
    tracker.add(8000);
    expect(tracker.total).toBeGreaterThan((SOFT * WINDOW) / 100);

    await runBeforePrompt(capture);
    expect(capture.queuedReminders).toHaveLength(0);
    expect(noticeEvents(emitEvent)).toHaveLength(0);
  });

  it('re-arms after usage falls below the band floor and fires again', async () => {
    const config = makeNudgeConfig();
    const tracker = makeTracker(config);
    const sessionManager = createSessionManager();
    const emitEvent = vi.fn();
    const provider = makeProvider({
      contextWindow: WINDOW,
      chatResponses: [{ message: 'Summary 11.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
      emitEvent,
    });

    const capture = await captureRegistration(plugin, config, provider);

    // First excursion: fire once. (No auto-compaction runs here — usage
    // stays inside the band, below the soft threshold.)
    while (tracker.total < BAND_FLOOR_TOKENS - 260) {
      sessionManager.appendUserMessage('x'.repeat(960));
      tracker.add(960);
    }
    sessionManager.appendUserMessage('x'.repeat(1200));
    tracker.add(1200);
    await runBeforePrompt(capture);
    expect(capture.queuedReminders).toHaveLength(1);
    expect(provider.__chatMock).not.toHaveBeenCalled();

    // Force a full compaction: usage collapses far below the band floor
    // into a known end state — exactly one small summary turn. The force
    // path itself must never queue a reminder.
    const handled = await runSlashCommand(capture, '/compact --all');
    expect(handled).toBe(true);
    expect(capture.queuedReminders).toHaveLength(1);
    expect(
      sessionManager.getTurns().filter(t => t.kind !== 'summary')
    ).toHaveLength(0);

    // Reset the token baseline to the exact post-compaction state:
    // system prompt + the single 'Summary 11.' turn.
    const postCompactionBaseline =
      systemPromptTokens(config) +
      (6 +
        Math.ceil('Conversation summary (compacted):\nSummary 11.'.length / 4));
    tracker.resetTo(postCompactionBaseline);

    // An evaluation at the collapsed usage level re-arms the nudge —
    // usage sits far below the band floor here.
    await runBeforePrompt(capture);
    expect(capture.queuedReminders).toHaveLength(1);

    // Rise into the band a second time: the nudge fires again.
    while (tracker.total < BAND_FLOOR_TOKENS - 260) {
      sessionManager.appendUserMessage('z'.repeat(960));
      tracker.add(960);
    }
    sessionManager.appendUserMessage('w'.repeat(1200));
    tracker.add(1200);
    await runBeforePrompt(capture);
    expect(capture.queuedReminders).toHaveLength(2);
    expect(noticeEvents(emitEvent)).toHaveLength(2);
  });

  it('never warns when compaction is disabled', async () => {
    const config = makeNudgeConfig({ enabled: false });
    const sessionManager = createSessionManager();
    const emitEvent = vi.fn();
    const provider = makeProvider({ contextWindow: WINDOW });
    const plugin = createCompactionPlugin({
      sessionManager,
      emitEvent,
    });

    const capture = await captureRegistration(plugin, config, provider);

    for (let i = 0; i < 20; i++) {
      sessionManager.appendUserMessage('x'.repeat(960));
    }
    await runBeforePrompt(capture);
    await runBeforePrompt(capture);
    await runAfterToolCall(capture);
    expect(capture.queuedReminders).toHaveLength(0);
    expect(noticeEvents(emitEvent)).toHaveLength(0);
    expect(provider.__contextMock).not.toHaveBeenCalled();
  });

  it('manual /compact never queues a reminder', async () => {
    const config = makeNudgeConfig();
    const sessionManager = createSessionManager();
    const emitEvent = vi.fn();
    const provider = makeProvider({
      contextWindow: WINDOW,
      chatResponses: [{ message: 'Manual summary.' }],
    });
    const plugin = createCompactionPlugin({
      sessionManager,
      emitEvent,
    });

    const capture = await captureRegistration(plugin, config, provider);

    for (let i = 0; i < 18; i++) {
      sessionManager.appendUserMessage('x'.repeat(960));
    }
    await runSlashCommand(capture, '/compact');
    expect(provider.__chatMock).toHaveBeenCalled();
    expect(capture.queuedReminders).toHaveLength(0);
    expect(noticeEvents(emitEvent)).toHaveLength(0);
  });

  it('reminder text names mounted tools and carries the rounded figure', async () => {
    const config = makeNudgeConfig();
    const tracker = makeTracker(config);
    const sessionManager = createSessionManager();
    const emitEvent = vi.fn();
    const provider = makeProvider({ contextWindow: WINDOW });
    const plugin = createCompactionPlugin({
      sessionManager,
      emitEvent,
    });

    const capture = await captureRegistration(plugin, config, provider);
    capture.mountedToolNames.push(
      'file__read',
      'notepad__manage',
      'todo__manage_list'
    );

    while (tracker.total < BAND_FLOOR_TOKENS - 260) {
      sessionManager.appendUserMessage('x'.repeat(960));
      tracker.add(960);
    }
    sessionManager.appendUserMessage('x'.repeat(1200));
    await runBeforePrompt(capture);

    expect(capture.queuedReminders).toHaveLength(1);
    const reminder = capture.queuedReminders[0];
    expect(reminder).toMatch(/approaching the compaction threshold/);
    expect(reminder).toMatch(/\d[\dk]* tokens before older conversation turns/);
    expect(reminder).toContain('`notepad__manage`');
    expect(reminder).toContain('`todo__manage_list`');
    expect(reminder).not.toContain('`file__read`');

    const [notice] = noticeEvents(emitEvent);
    expect(notice).toMatchObject({ kind: 'notice' });
    expect(String((notice as { content: string }).content)).toMatch(
      /^\[Compaction in \d[\dk]* tokens\]$/
    );
  });

  it('omits the tool clause when neither notepad nor todo tools are mounted', async () => {
    const config = makeNudgeConfig();
    const sessionManager = createSessionManager();
    const emitEvent = vi.fn();
    const provider = makeProvider({ contextWindow: WINDOW });
    const plugin = createCompactionPlugin({
      sessionManager,
      emitEvent,
    });

    const capture = await captureRegistration(plugin, config, provider);
    capture.mountedToolNames.push('file__read');

    for (let i = 0; i < 18; i++) {
      sessionManager.appendUserMessage('x'.repeat(960));
    }
    await runBeforePrompt(capture);

    expect(capture.queuedReminders).toHaveLength(1);
    expect(capture.queuedReminders[0]).toMatch(
      /approaching the compaction threshold/
    );
    expect(capture.queuedReminders[0]).not.toContain('notepad__manage');
    expect(capture.queuedReminders[0]).not.toContain('todo__manage_list');
  });
});

describe('compaction summarizer model role', () => {
  it('names the resolved role model in compaction events', async () => {
    const sessionManager = createSessionManager();
    for (let i = 0; i < 4; i++) {
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

    const roleProvider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'A concise summary.' }],
    });
    const emitEvent = vi.fn();
    const plugin = createCompactionPlugin({ sessionManager, emitEvent });
    const capture = await captureRegistration(plugin, config, roleProvider, {
      provider: roleProvider,
      providerId: 'ollama',
      model: 'cheap-model',
    });

    await runBeforePrompt(capture);
    const first = emitEvent.mock.calls[0]?.[0] as { message: string };
    expect(first.message).toContain('ollama/cheap-model');
    const completed = emitEvent.mock.calls[1]?.[0] as { message: string };
    expect(completed.message).toContain('ollama/cheap-model');
  });

  it('probes the context window against the resolved role provider', async () => {
    const sessionManager = createSessionManager();
    for (let i = 0; i < 4; i++) {
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

    const roleProvider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'A concise summary.' }],
    });
    const plugin = createCompactionPlugin({ sessionManager });
    const capture = await captureRegistration(plugin, config, roleProvider, {
      provider: roleProvider,
      providerId: 'ollama',
      model: 'cheap-model',
    });

    await runBeforePrompt(capture);
    expect(roleProvider.__contextMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'cheap-model' })
    );
  });

  it('threads the resolved reasoningLevel into the summary chat call', async () => {
    const sessionManager = createSessionManager();
    for (let i = 0; i < 4; i++) {
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

    const roleProvider = makeProvider({
      contextWindow: 200,
      chatResponses: [{ message: 'A concise summary.' }],
    });
    const plugin = createCompactionPlugin({ sessionManager });
    const capture = await captureRegistration(plugin, config, roleProvider, {
      provider: roleProvider,
      providerId: 'ollama',
      model: 'cheap-model',
      reasoningLevel: 'high',
    });

    await runBeforePrompt(capture);
    expect(roleProvider.__chatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'cheap-model',
        reasoningLevel: 'high',
      })
    );
  });
});

describe('pre-compaction image description flush', () => {
  it('describes undescribed images in the turns being compacted before summarizing', async () => {
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
      chatResponses: [{ message: 'Summary with image context.' }],
    });

    const described: string[] = [];
    const describeImagesOverride = async (
      images: import('drone-core').DroneImageContent[]
    ): Promise<import('drone-core').DroneImageContent[]> => {
      return images.map(img => {
        described.push(img.data);
        return { ...img, description: 'a red circle on a white background' };
      });
    };

    const plugin = createCompactionPlugin({ sessionManager });
    const capture = await captureRegistration(
      plugin,
      config,
      provider,
      undefined,
      describeImagesOverride
    );

    // Two turns, one carrying an undescribed image, to exceed the low threshold.
    sessionManager.appendUserMessage('q1', [
      { data: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
    ]);
    sessionManager.appendAssistantMessage('a1');
    sessionManager.appendUserMessage('q2');
    sessionManager.appendAssistantMessage('a2');

    await runAfterToolCall(capture);

    // The flush should have described the image before the summary was built.
    expect(described).toEqual(['data:image/png;base64,AAAA']);
    expect(provider.__chatMock).toHaveBeenCalled();
    // The summary prompt should carry the description text.
    const prompt = JSON.stringify(provider.__chatMock.mock.calls);
    expect(prompt).toContain('a red circle on a white background');
  });

  it('fails open when describeImages throws, still compacting', async () => {
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
      chatResponses: [{ message: 'Summary.' }],
    });

    const plugin = createCompactionPlugin({ sessionManager });
    const capture = await captureRegistration(
      plugin,
      config,
      provider,
      undefined,
      async () => {
        throw new Error('describer down');
      }
    );

    sessionManager.appendUserMessage('q1', [
      { data: 'data:image/png;base64,BBBB', mimeType: 'image/png' },
    ]);
    sessionManager.appendAssistantMessage('a1');
    sessionManager.appendUserMessage('q2');
    sessionManager.appendAssistantMessage('a2');

    await runAfterToolCall(capture);

    // Compaction still proceeds despite the describer failure.
    expect(provider.__chatMock).toHaveBeenCalled();
    expect(sessionManager.getSummaryTurns().length).toBeGreaterThan(0);
  });
});
