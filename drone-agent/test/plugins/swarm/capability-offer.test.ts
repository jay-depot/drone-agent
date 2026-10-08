import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSwarmPlugin } from '../../../src/plugins/swarm/index.js';
import { silentLogger } from '../../helpers.js';
import {
  createDefaultAgentConfig,
  type DronePluginRegistration,
  type DronePromptFragment,
  type DroneSwarmCapability,
  type DroneSessionImportCapability,
} from 'drone-core';

/**
 * The engine's capability registry is ONE SLOT PER PLUGIN ID: `offer` does
 * `capabilities.set(plugin.metadata.id, capability)`, so a second `offer()`
 * from the same plugin silently clobbers the first. This capture reproduces
 * that exact semantics (a Map keyed by plugin id) so a regression that
 * reintroduces a second `offer` fails here instead of at runtime.
 */
function createCapture() {
  const offers = new Map<string, unknown>();
  let onShutdown: (() => Promise<void>) | undefined;

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => createDefaultAgentConfig(),
    registerTool: () => {},
    registerPromptFragment: (_fragment: DronePromptFragment) => {},
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
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onShutdown: cb => {
        onShutdown = cb;
      },
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: capability => {
      offers.set('swarm', capability);
    },
    request: () => undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    getCliFlags: () => ({}),
    requestElicitation: () => undefined,
  };

  return { registration, offers, getOnShutdown: () => onShutdown };
}

describe('swarm plugin capability offer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function register(): Promise<ReturnType<typeof createCapture>> {
    const capture = createCapture();
    await createSwarmPlugin({}).register(capture.registration);
    await capture.getOnShutdown()?.();
    return capture;
  }

  it('offers exactly one capability object under the swarm id', async () => {
    const { offers } = await register();
    expect(offers.size).toBe(1);
    expect(offers.has('swarm')).toBe(true);
  });

  it('the offered capability carries both the beacon accessors and runImport', async () => {
    const { offers } = await register();
    const capability = offers.get('swarm') as DroneSwarmCapability &
      DroneSessionImportCapability;

    expect(capability.getBeaconUrl()).toBe('http://localhost:3457');
    expect(capability.getAgentId()).toEqual(expect.any(String));
    expect(typeof capability.runImport).toBe('function');
  });
});
