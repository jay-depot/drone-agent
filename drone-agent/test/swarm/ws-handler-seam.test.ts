import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DronePluginRegistration } from 'drone-core';
import { createSwarmContext } from '../../src/plugins/swarm/context.js';
import {
  connectWebSocket,
  dispatchCustomWsMessage,
} from '../../src/plugins/swarm/websocket.js';
import { silentLogger } from '../helpers.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];
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
    unmountTool: () => ({ unmounted: true }),
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

function makeCtx() {
  return createSwarmContext(
    'http://beacon.test',
    'sess-1',
    makeRegistration(),
    'ws://beacon.test/ws?agentId=sess-1',
    'beacon.test:3457'
  );
}

describe('dispatchCustomWsMessage', () => {
  it('invokes a registered handler for a custom frame type', () => {
    const ctx = makeCtx();
    const handler = vi.fn();
    ctx.wsHandlers.set('injection', new Set([handler]));

    const ran = dispatchCustomWsMessage(ctx, 'injection', { kind: 'fragment' });
    expect(ran).toBe(true);
    expect(handler).toHaveBeenCalledWith(
      { kind: 'fragment' },
      {
        type: 'injection',
        payload: { kind: 'fragment' },
      }
    );
  });

  it('returns false when no handler is registered for the type', () => {
    const ctx = makeCtx();
    expect(dispatchCustomWsMessage(ctx, 'unknown', {})).toBe(false);
  });

  it('tolerates a throwing handler without breaking the loop', () => {
    const ctx = makeCtx();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    ctx.wsHandlers.set('injection', new Set([bad, good]));

    expect(() => dispatchCustomWsMessage(ctx, 'injection', {})).not.toThrow();
    expect(good).toHaveBeenCalled();
  });
});

describe('swarm WS seam routes unknown frames to handlers', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dispatches a custom frame over the live socket', () => {
    const ctx = makeCtx();
    const handler = vi.fn();
    ctx.wsHandlers.set('injection', new Set([handler]));
    connectWebSocket(ctx);

    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({
      data: JSON.stringify({ type: 'injection', payload: { kind: 'tools' } }),
    });

    expect(handler).toHaveBeenCalledWith(
      { kind: 'tools' },
      {
        type: 'injection',
        payload: { kind: 'tools' },
      }
    );
  });
});
