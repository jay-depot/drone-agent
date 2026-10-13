import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DronePluginRegistration } from 'drone-core';
import { createSwarmContext } from '../../src/plugins/swarm/context.js';
import {
  recycleSwarmSession,
  registerHooks,
} from '../../src/plugins/swarm/hooks.js';
import { buildWsUrl } from '../../src/plugins/swarm/websocket.js';
import { silentLogger } from '../helpers.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

function makeRegistration(): DronePluginRegistration {
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
    listMountedTools: () => [],
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
    request: () => undefined,
    runWorkflow: async () => ({ toolResult: '{}' }),
    getCliFlags: () => ({}),
    requestElicitation: () => undefined,
    listPlugins: () => [],
  };
}

describe('buildWsUrl', () => {
  it('builds ws/wss URLs from http/https base urls', () => {
    expect(buildWsUrl('http://beacon:3457', 'a1')).toBe(
      'ws://beacon:3457/ws?agentId=a1'
    );
    expect(buildWsUrl('https://beacon:3457', 'a1')).toBe(
      'wss://beacon:3457/ws?agentId=a1'
    );
  });
});

describe('recycleSwarmSession', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-registers the agent, updates the id + wsUrl, and reconnects', async () => {
    const registration = makeRegistration();
    const ctx = createSwarmContext(
      'http://beacon.test',
      'old-session',
      registration,
      'ws://beacon.test/ws?agentId=old-session',
      'beacon.test:3457'
    );
    // Seed a stale socket.
    ctx.ws = new FakeWebSocket(ctx.wsUrl) as unknown as WebSocket;
    const stale = ctx.ws;

    await recycleSwarmSession(ctx, registration, 'new-session');

    expect(ctx.sessionId).toBe('new-session');
    expect(ctx.wsUrl).toBe('ws://beacon.test/ws?agentId=new-session');
    // The stale socket was closed.
    expect((stale as unknown as FakeWebSocket).closed).toBe(true);
    // A new socket was constructed on the new URL.
    const latest = FakeWebSocket.instances.at(-1);
    expect(latest?.url).toBe('ws://beacon.test/ws?agentId=new-session');
    // POST /agents used the new id.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://beacon.test/agents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ id: 'new-session', personaId: null }),
      })
    );
  });

  it('clears the correlation id and event buffer on recycle', async () => {
    const registration = makeRegistration();
    const ctx = createSwarmContext(
      'http://beacon.test',
      'old',
      registration,
      'ws://beacon.test/ws?agentId=old',
      'beacon.test:3457'
    );
    ctx.currentCorrelationId = 'corr-1';
    ctx.eventBuffer.push({
      id: 'e1',
      sessionId: 'old',
      type: 'notice',
      createdAt: 1,
    });

    await recycleSwarmSession(ctx, registration, 'new');

    expect(ctx.currentCorrelationId).toBeNull();
    expect(ctx.eventBuffer).toHaveLength(0);
  });
});

describe('registerHooks wires onSessionRecycle', () => {
  it('registers a recycle hook that recycles the session', async () => {
    const registration = makeRegistration();
    let recycle: ((p: { sessionId: string }) => Promise<void>) | undefined;
    registration.hooks.onSessionRecycle = cb => {
      recycle = cb as (p: { sessionId: string }) => Promise<void>;
    };
    const ctx = createSwarmContext(
      'http://beacon.test',
      'old',
      registration,
      'ws://beacon.test/ws?agentId=old',
      'beacon.test:3457'
    );
    registerHooks(ctx, undefined, null, false);
    expect(recycle).toBeDefined();
    await recycle?.({ sessionId: 'brand-new' });
    expect(ctx.sessionId).toBe('brand-new');
  });
});
