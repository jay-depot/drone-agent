import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { DronePluginRegistration } from 'drone-core';
import { createSwarmContext } from '../../src/plugins/swarm/context.js';
import { connectWebSocket } from '../../src/plugins/swarm/websocket.js';
import { silentLogger } from '../helpers.js';

/** Minimal fake WebSocket capturing handlers so tests can drive the loop. */
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

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitOpen(): void {
    this.onopen?.();
  }
}

function makeRegistration(): DronePluginRegistration {
  return {
    logger: silentLogger(),
    request: () => undefined,
  } as unknown as DronePluginRegistration;
}

describe('connectWebSocket swarm-info caching', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.endsWith('/info')) {
          return {
            ok: true,
            json: async () => ({
              id: 'b1',
              name: 'from-fetch',
              coordinatorHost: null,
              coordinatorPort: null,
            }),
          } as Response;
        }
        return { ok: true, json: async () => [] } as Response;
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('caches the beacon info pushed in the connected handshake', () => {
    const ctx = createSwarmContext(
      'http://beacon.test',
      'agent-1',
      makeRegistration(),
      'ws://beacon.test/ws',
      'localhost:3457'
    );
    connectWebSocket(ctx);
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('no WebSocket constructed');

    ws.emitMessage({
      type: 'connected',
      payload: {
        agentId: 'agent-1',
        info: {
          id: 'b1',
          name: 'home-office',
          coordinatorHost: 'coord.example',
          coordinatorPort: 3456,
        },
      },
    });

    expect(ctx.swarmInfo.getInfo()).toMatchObject({
      id: 'b1',
      name: 'home-office',
      coordinatorHost: 'coord.example',
      coordinatorPort: 3456,
    });
  });

  it('ignores a connected handshake without an info payload', () => {
    const ctx = createSwarmContext(
      'http://beacon.test',
      'agent-1',
      makeRegistration(),
      'ws://beacon.test/ws',
      'localhost:3457'
    );
    connectWebSocket(ctx);
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('no WebSocket constructed');

    ws.emitMessage({ type: 'connected', payload: { agentId: 'agent-1' } });
    expect(ctx.swarmInfo.getInfo()).toBeNull();
  });

  it('invokes _runtime.requestShutdown on a shutdown message', () => {
    const requestShutdown = vi.fn();
    const registration = {
      logger: silentLogger(),
      request: (id: string) =>
        id === 'runtime' ? { requestShutdown } : undefined,
    } as unknown as DronePluginRegistration;
    const ctx = createSwarmContext(
      'http://beacon.test',
      'agent-1',
      registration,
      'ws://beacon.test/ws',
      'localhost:3457'
    );
    connectWebSocket(ctx);
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('no WebSocket constructed');

    ws.emitMessage({ type: 'shutdown' });

    expect(requestShutdown).toHaveBeenCalledTimes(1);
  });

  it('warns but does not throw when no shutdown handler is registered', () => {
    const ctx = createSwarmContext(
      'http://beacon.test',
      'agent-1',
      makeRegistration(),
      'ws://beacon.test/ws',
      'localhost:3457'
    );
    connectWebSocket(ctx);
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) throw new Error('no WebSocket constructed');

    expect(() => ws.emitMessage({ type: 'shutdown' })).not.toThrow();
  });
});
