import { describe, expect, it, vi } from 'vitest';
import type {
  DroneAgentConfig,
  DroneLlmCapability,
  DroneLogger,
  DronePluginRegistration,
  LlmProtocolDriver,
} from 'drone-core';
import { createDefaultAgentConfig } from 'drone-core';
import { llmPlugin } from '../src/plugins/llm/index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = {
  capability: DroneLlmCapability;
  config: DroneAgentConfig;
  runLoadedHooks: () => Promise<void>;
  /** Simulate the config plugin firing its subscribers after a rebuild(). */
  fireConfigChange: () => void;
  /** The unsubscribe fn the (mocked) config capability handed back. */
  unsubscribeConfig: () => void;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
};

const TEST_PROTOCOL = 'testproto';

function makeDriver(
  discoverModels?: LlmProtocolDriver['discoverModels']
): LlmProtocolDriver {
  return {
    protocolId: TEST_PROTOCOL,
    createProvider: () => ({
      chat: async () => ({ message: 'ok' }),
      getContextWindowInfo: async () => null,
    }),
    parameterSchema: { parameters: {} },
    ...(discoverModels ? { discoverModels } : {}),
  };
}

async function makeHarness(opts: {
  providers: Record<string, string[]>;
  llmActive?: string;
  discoverModels?: LlmProtocolDriver['discoverModels'];
}): Promise<Harness> {
  const config = createDefaultAgentConfig();
  config.providers = Object.fromEntries(
    Object.entries(opts.providers).map(([id, models]) => [
      id,
      {
        protocol: TEST_PROTOCOL,
        models: Object.fromEntries(models.map(m => [m, {}])),
      },
    ])
  );
  if (opts.llmActive !== undefined) {
    config.llm.active = opts.llmActive;
  }

  const info = vi.fn();
  const warn = vi.fn();
  const changeHandlers: Array<() => void> = [];
  const unsubscribes: Array<() => void> = [];
  let offered: DroneLlmCapability | undefined;
  const loadedHooks: Array<() => Promise<void>> = [];

  const registration: DronePluginRegistration = {
    logger: { info, warn, error: vi.fn() } as unknown as DroneLogger,
    getConfig: () => config,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    emitEvent: () => {},
    hooks: {
      onPluginsLoaded: cb => {
        loadedHooks.push(cb);
      },
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: cap => {
      offered = cap as DroneLlmCapability;
    },
    request: <T>(pluginId: string) =>
      pluginId === 'config'
        ? ({
            onLayersChanged: (cb: () => void) => {
              changeHandlers.push(cb);
              const unsubscribe = () => {
                const idx = changeHandlers.indexOf(cb);
                if (idx !== -1) changeHandlers.splice(idx, 1);
              };
              unsubscribes.push(unsubscribe);
              return unsubscribe;
            },
          } as unknown as T)
        : (undefined as T | undefined),
    runWorkflow: async () => ({ toolResult: '{}' }),
    getCliFlags: () => ({}),
    requestElicitation: () => undefined,
  };

  await llmPlugin.register(registration);
  if (!offered) {
    throw new Error('Expected llm capability to be offered.');
  }
  offered.registerDriver(makeDriver(opts.discoverModels));

  return {
    capability: offered,
    config,
    runLoadedHooks: async () => {
      for (const hook of loadedHooks) {
        await hook();
      }
    },
    fireConfigChange: () => {
      for (const handler of [...changeHandlers]) {
        handler();
      }
    },
    unsubscribeConfig: () => {
      for (const unsubscribe of [...unsubscribes]) {
        unsubscribe();
      }
    },
    info,
    warn,
  };
}

function lastInfoContaining(info: ReturnType<typeof vi.fn>, needle: string) {
  const calls = info.mock.calls.map(args => String(args[0]));
  return calls.filter(call => call.includes(needle));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('llm underlay reactivity', () => {
  it('subscribes to config-layer changes', async () => {
    const harness = await makeHarness({ providers: { alpha: ['alpha-1'] } });
    expect(harness).toBeDefined();
  });

  it('a config change invalidates the stale listing immediately', async () => {
    const discoverModels = vi.fn(async () => []);
    const harness = await makeHarness({
      providers: { alpha: ['alpha-1'] },
      discoverModels,
    });
    await harness.runLoadedHooks();
    (discoverModels as ReturnType<typeof vi.fn>).mockClear();

    // The "underlay" arrives: a new provider entry appears in config.
    harness.config.providers['beta'] = {
      protocol: TEST_PROTOCOL,
      models: { 'beta-1': {} },
    } as DroneAgentConfig['providers'][string];
    harness.fireConfigChange();

    // Stale-cache symptom would be 'beta/beta-1' missing until the 60s TTL
    // expires; with reactivity it appears on the next listing immediately.
    const models = await harness.capability.listModels();
    expect(models).toContain('beta/beta-1');
    expect(discoverModels).toHaveBeenCalled();
  });

  it('auto-activates a swarm-distributed llm.active when no manual selection exists', async () => {
    // beta does not exist at startup: the pin is unresolvable, startup falls
    // back to alpha. The underlay then delivers beta.
    const harness = await makeHarness({
      providers: { alpha: ['alpha-1'] },
      llmActive: 'beta/beta-1',
    });
    await harness.runLoadedHooks();
    expect(harness.capability.getActiveProviderId()).toBe('alpha');

    harness.config.providers['beta'] = {
      protocol: TEST_PROTOCOL,
      models: { 'beta-1': {} },
    } as DroneAgentConfig['providers'][string];
    harness.fireConfigChange();

    expect(harness.capability.getActiveProviderId()).toBe('beta');
    expect(harness.capability.getModel()).toBe('beta-1');
    expect(lastInfoContaining(harness.info, 'underlay applied')).toHaveLength(
      1
    );
  });

  it('keeps a manual selection and notices once when llm.active differs', async () => {
    const harness = await makeHarness({ providers: { alpha: ['alpha-1'] } });
    await harness.runLoadedHooks();
    harness.capability.setModel('alpha/alpha-1');

    harness.config.providers['beta'] = {
      protocol: TEST_PROTOCOL,
      models: { 'beta-1': {} },
    } as DroneAgentConfig['providers'][string];
    harness.config.llm.active = 'beta/beta-1';

    harness.fireConfigChange();
    expect(harness.capability.getActiveProviderId()).toBe('alpha');
    expect(harness.capability.getModel()).toBe('alpha-1');
    expect(lastInfoContaining(harness.info, 'current selection')).toHaveLength(
      1
    );

    // An identical re-apply (no-op rebuild) must not re-notice.
    harness.fireConfigChange();
    expect(lastInfoContaining(harness.info, 'current selection')).toHaveLength(
      1
    );
  });

  it('keeps serving a vanished active provider with a warn', async () => {
    const harness = await makeHarness({ providers: { alpha: ['alpha-1'] } });
    await harness.runLoadedHooks();
    expect(harness.capability.getActiveProviderId()).toBe('alpha');

    harness.config.providers = {};
    harness.config.llm.active = undefined;
    harness.fireConfigChange();

    // Cached instance keeps serving (chat continuity; no eviction).
    expect(harness.capability.getActiveProviderId()).toBe('alpha');
    expect(harness.capability.getActiveProvider).toBeDefined();
    expect(
      lastInfoContaining(harness.warn, 'no longer configured')
    ).toHaveLength(1);
  });

  it('an identical rebuild is a no-op (no invalidation, no change logs)', async () => {
    const discoverModels = vi.fn(async () => []);
    const harness = await makeHarness({
      providers: { alpha: ['alpha-1'] },
      discoverModels,
    });
    await harness.runLoadedHooks();
    (discoverModels as ReturnType<typeof vi.fn>).mockClear();

    // Simulate a rebuild that produces an identical layer result.
    harness.fireConfigChange();

    // The discovery cache must still be valid: the next listing hits the
    // cache instead of re-discovering.
    await harness.capability.listModels();
    expect(discoverModels).not.toHaveBeenCalled();
    expect(lastInfoContaining(harness.info, 'LLM config changed')).toHaveLength(
      0
    );
  });

  it('unsubscribe stops the broker from reacting', async () => {
    const discoverModels = vi.fn(async () => []);
    const harness = await makeHarness({
      providers: { alpha: ['alpha-1'] },
      llmActive: 'alpha/alpha-1',
      discoverModels,
    });
    await harness.runLoadedHooks();
    (discoverModels as ReturnType<typeof vi.fn>).mockClear();

    harness.unsubscribeConfig();

    harness.config.providers['beta'] = {
      protocol: TEST_PROTOCOL,
      models: { 'beta-1': {} },
    } as DroneAgentConfig['providers'][string];
    harness.config.llm.active = 'beta/beta-1';
    harness.fireConfigChange();

    expect(harness.capability.getActiveProviderId()).toBe('alpha');
    const models = await harness.capability.listModels();
    // No invalidation happened, so the pre-underlay cache is still served.
    expect(models).toEqual(['alpha/alpha-1']);
    expect(discoverModels).not.toHaveBeenCalled();
  });
});
