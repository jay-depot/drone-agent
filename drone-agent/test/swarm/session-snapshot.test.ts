import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DronePluginRegistration } from 'drone-core';
import { createSwarmContext } from '../../src/plugins/swarm/context.js';
import {
  buildSessionSnapshot,
  registerSwarmSession,
} from '../../src/plugins/swarm/hooks.js';
import { silentLogger } from '../helpers.js';

function makeRegistration(
  opts: {
    runtime?: { isSubagent?: boolean; extensionHint?: string };
    plugins?: Array<{ id: string; enabled: boolean }>;
    mountedTools?: string[];
  } = {}
): DronePluginRegistration {
  return {
    logger: silentLogger(),
    getConfig: () => ({}) as never,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () =>
      (opts.mountedTools ?? []).map(name => ({
        name,
        description: '',
        inputSchema: {},
      })),
    emitEvent: () => {},
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onSessionRecycle: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: <T>(pluginId: string): T | undefined =>
      pluginId === 'runtime' ? (opts.runtime as T) : undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    getCliFlags: () => ({}),
    requestElicitation: () => undefined,
    listPlugins: () =>
      (opts.plugins ?? []).map(p => ({
        id: p.id,
        name: p.id,
        enabled: p.enabled,
        required: false,
        defaultEnabled: false,
      })),
  };
}

function makeCtx(registration: DronePluginRegistration) {
  return createSwarmContext(
    'http://beacon.test',
    'sess-1',
    registration,
    'ws://beacon.test/ws?agentId=sess-1',
    'beacon.test:3457'
  );
}

describe('buildSessionSnapshot', () => {
  it('assembles a names-only snapshot', () => {
    const registration = makeRegistration({
      plugins: [
        { id: 'swarm', enabled: true },
        { id: 'extensions', enabled: true },
        { id: 'telemetry', enabled: false },
      ],
      mountedTools: ['file__read', 'extensions__a__b'],
    });
    const snapshot = buildSessionSnapshot(makeCtx(registration), false);

    expect(snapshot.protocolVersion).toBe(1);
    expect(snapshot.sessionId).toBe('sess-1');
    expect(snapshot.beaconId).toBe('sess-1');
    expect(snapshot.enabledPlugins).toEqual(['swarm', 'extensions']);
    expect(snapshot.mountedTools).toEqual(['file__read', 'extensions__a__b']);
    expect(snapshot.isSubagent).toBe(false);
    expect(snapshot.interactive).toBe(false);
  });

  it('reflects interactive + subagent + extensionHint flags', () => {
    const registration = makeRegistration({
      runtime: { isSubagent: true, extensionHint: 'gateway-42' },
    });
    const snapshot = buildSessionSnapshot(makeCtx(registration), true);
    expect(snapshot.interactive).toBe(true);
    expect(snapshot.isSubagent).toBe(true);
    expect(snapshot.extensionHint).toBe('gateway-42');
  });

  it('omits extensionHint when the runtime has none', () => {
    const snapshot = buildSessionSnapshot(makeCtx(makeRegistration()), false);
    expect(snapshot.extensionHint).toBeUndefined();
  });
});

describe('registerSwarmSession forwards the snapshot', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the snapshot to /sync/sessions/register', async () => {
    const registration = makeRegistration();
    await registerSwarmSession(makeCtx(registration));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('http://beacon.test/sync/sessions/register');
    const body = JSON.parse(init.body);
    expect(body.snapshot).toMatchObject({
      sessionId: 'sess-1',
      protocolVersion: 1,
    });
  });
});
