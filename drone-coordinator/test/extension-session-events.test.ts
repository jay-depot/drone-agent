import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { DroneSessionSnapshot } from 'drone-core';
import {
  _registerTestConnection,
  _disconnectTestConnection,
  resetBeaconConnections,
  broadcastBeaconEvent,
} from '../src/beacon-ws.js';
import { resetExtensionRegistry } from '../src/extension-registry.js';

function makeFakeWs() {
  const send = vi.fn((data: string, cb?: (err?: Error) => void) => cb?.());
  const ws = {
    send,
    ping: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  };
  return Object.assign(ws as unknown as WebSocket, { send });
}

function frames(ws: { send: ReturnType<typeof vi.fn> }): Array<{
  type: string;
  event?: string;
  session?: unknown;
  command?: string;
}> {
  return ws.send.mock.calls.map(c => JSON.parse(String(c[0])));
}

function snapshot(sessionId: string): DroneSessionSnapshot {
  return {
    protocolVersion: 1,
    sessionId,
    personaId: 'coder',
    beaconId: 'b1',
    interactive: false,
    isSubagent: false,
    cwd: '/tmp',
    enabledPlugins: ['swarm'],
    mountedTools: [],
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
  resetBeaconConnections();
  resetExtensionRegistry();
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

describe('sessionStarted broadcast', () => {
  it('broadcasts sessionStarted to every connected node on register', async () => {
    const nodeWs = makeFakeWs();
    _registerTestConnection('node-1', nodeWs);
    nodeWs.send.mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: {
        id: 'sess-1',
        beaconId: 'b1',
        snapshot: snapshot('sess-1'),
      },
    });
    expect(res.statusCode).toBe(201);

    const started = frames(nodeWs).find(f => f.event === 'sessionStarted');
    expect(started).toBeDefined();
    expect((started!.session as DroneSessionSnapshot).sessionId).toBe('sess-1');
  });

  it('does not broadcast when no snapshot is supplied', async () => {
    const nodeWs = makeFakeWs();
    _registerTestConnection('node-1', nodeWs);
    nodeWs.send.mockClear();

    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'sess-2', beaconId: 'b1' },
    });
    expect(frames(nodeWs).some(f => f.event === 'sessionStarted')).toBe(false);
  });

  it('broadcasts sessionEnded to every connected node on end', async () => {
    const nodeWs = makeFakeWs();
    _registerTestConnection('node-1', nodeWs);

    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: {
        id: 'sess-3',
        beaconId: 'b1',
        snapshot: { ...snapshot('sess-3'), extensionHint: 'gw-1' },
      },
    });
    nodeWs.send.mockClear();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sync/sessions/sess-3',
    });
    expect(res.statusCode).toBe(200);

    const ended = frames(nodeWs).find(f => f.event === 'sessionEnded');
    expect(ended).toBeDefined();
    expect(ended!.session).toMatchObject({
      sessionId: 'sess-3',
      extensionHint: 'gw-1',
    });
  });
});

describe('sessionStarted replay on connect', () => {
  it('replays active-session snapshots to a newly connected node', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: {
        id: 'live-1',
        beaconId: 'b1',
        snapshot: snapshot('live-1'),
      },
    });

    const lateWs = makeFakeWs();
    _registerTestConnection('late-node', lateWs);

    const started = frames(lateWs).filter(f => f.event === 'sessionStarted');
    expect(started).toHaveLength(1);
    expect((started[0].session as DroneSessionSnapshot).sessionId).toBe('live-1');
  });

  it('does not replay ended sessions', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: {
        id: 'gone-1',
        beaconId: 'b1',
        snapshot: snapshot('gone-1'),
      },
    });
    await app.inject({ method: 'DELETE', url: '/api/sync/sessions/gone-1' });

    const lateWs = makeFakeWs();
    _registerTestConnection('late-node-2', lateWs);
    expect(frames(lateWs).some(f => f.event === 'sessionStarted')).toBe(false);
  });
});

describe('broadcastBeaconEvent', () => {
  it('sends to all connected nodes and tolerates a send error', () => {
    const ws1 = makeFakeWs();
    const ws2 = makeFakeWs();
    ws2.send.mockImplementation((_d: string, cb?: (err?: Error) => void) => {
      cb?.(new Error('boom'));
    });
    _registerTestConnection('n1', ws1);
    _registerTestConnection('n2', ws2);

    expect(() =>
      broadcastBeaconEvent({ type: 'event', event: 'sessionEnded' })
    ).not.toThrow();
    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);
  });

  it('is a no-op with no connections', () => {
    expect(() =>
      broadcastBeaconEvent({ type: 'event', event: 'sessionEnded' })
    ).not.toThrow();
  });
});

describe('disconnect cleanup clears the manifest', () => {
  it('drops the extension manifest on disconnect', async () => {
    const nodeWs = makeFakeWs();
    _registerTestConnection('node-x', nodeWs);
    // declare a manifest via the inbound dispatch path
    const { _handleIncomingMessage } = await import('../src/beacon-ws.js');
    _handleIncomingMessage(
      JSON.stringify({
        type: 'manifest',
        protocolVersion: 1,
        capabilities: [],
        bundles: [],
      }),
      'node-x'
    );
    _disconnectTestConnection('node-x');
    await new Promise(r => setImmediate(r));
    const registry = await import('../src/extension-registry.js');
    expect(registry.isExtension('node-x')).toBe(false);
  });
});
