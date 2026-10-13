import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  _registerTestConnection,
  _handleIncomingMessage,
  _disconnectTestConnection,
  resetBeaconConnections,
  sendBeaconCommand,
  getConnectedBeaconIds,
} from '../src/beacon-ws.js';
import {
  getManifest,
  isExtension,
  listExtensionNodeIds,
  resetExtensionRegistry,
} from '../src/extension-registry.js';
import { setupDb, teardownDb } from './setup.js';
import { createSwarmSession, getCapabilityCache } from '../src/db/index.js';
import type { WebSocket } from '@fastify/websocket';

function makeFakeWs() {
  const send = vi.fn((data: string, cb?: (err?: Error) => void) => cb?.());
  const ping = vi.fn();
  const terminate = vi.fn();
  const handlers = new Map<string, () => void>();
  const ws = {
    send,
    ping,
    terminate,
    on: vi.fn((ev: string, cb: () => void) => {
      handlers.set(ev, cb);
    }),
    close: vi.fn(),
    readyState: 1,
    handlers,
  };
  return Object.assign(ws as unknown as WebSocket, {
    send,
    ping,
    terminate,
    handlers,
  });
}

function lastCommand(ws: { send: ReturnType<typeof vi.fn> }): {
  type: string;
  command: string;
  payload: unknown;
} {
  const calls = ws.send.mock.calls;
  return JSON.parse(String(calls[calls.length - 1][0]));
}

beforeEach(async () => {
  resetBeaconConnections();
  resetExtensionRegistry();
  await setupDb();
});

afterEach(async () => {
  await teardownDb();
});

describe('extension manifest frames', () => {
  it('admits a manifest and marks the node as an extension', () => {
    _handleIncomingMessage(
      JSON.stringify({
        type: 'manifest',
        protocolVersion: 1,
        capabilities: [
          {
            name: 'swarm.session.list',
            description: 'List sessions',
            paramSchema: { type: 'object' },
          },
        ],
        bundles: [{ name: 'panel', version: '1.0.0', hash: 'h1' }],
      }),
      'node-1'
    );
    expect(isExtension('node-1')).toBe(true);
    expect(listExtensionNodeIds()).toEqual(['node-1']);
    expect(getManifest('node-1')?.capabilities[0].name).toBe(
      'swarm.session.list'
    );
  });

  it('replaces a manifest on re-declaration', () => {
    _handleIncomingMessage(
      JSON.stringify({
        type: 'manifest',
        protocolVersion: 1,
        capabilities: [],
        bundles: [],
      }),
      'node-1'
    );
    _handleIncomingMessage(
      JSON.stringify({
        type: 'manifest',
        protocolVersion: 1,
        capabilities: [
          { name: 'a', description: 'A', paramSchema: {} },
        ],
        bundles: [],
      }),
      'node-1'
    );
    expect(getManifest('node-1')?.capabilities).toHaveLength(1);
    expect(getManifest('node-1')?.capabilities[0].name).toBe('a');
  });

  it('rejects a manifest with a mismatched protocol version', () => {
    _handleIncomingMessage(
      JSON.stringify({
        type: 'manifest',
        protocolVersion: 99,
        capabilities: [],
        bundles: [],
      }),
      'node-1'
    );
    expect(isExtension('node-1')).toBe(false);
  });

  it('caches the last-known manifest to the DB', () => {
    _handleIncomingMessage(
      JSON.stringify({
        type: 'manifest',
        protocolVersion: 1,
        capabilities: [
          { name: 'a', description: 'A', paramSchema: {} },
        ],
        bundles: [],
      }),
      'node-1'
    );
    expect(getCapabilityCache('node-1')?.manifest.capabilities[0].name).toBe(
      'a'
    );
  });
});

describe('inject fan-out', () => {
  it('forwards an inject frame to the host beacon of the target session', async () => {
    createSwarmSession('sess-1', null, 'host-beacon');
    const hostWs = makeFakeWs();
    _registerTestConnection('host-beacon', hostWs);

    _handleIncomingMessage(
      JSON.stringify({
        type: 'inject',
        id: 'inj-1',
        target: 'sess-1',
        kind: 'fragment',
        content: '# Hello',
      }),
      'node-1'
    );

    // forwardCommand resolves async; flush the microtask queue.
    await new Promise(r => setImmediate(r));

    const sent = lastCommand(hostWs);
    expect(sent.type).toBe('command');
    expect(sent.command).toBe('inject');
    expect(sent.payload).toMatchObject({
      extensionId: 'node-1',
      id: 'inj-1',
      target: 'sess-1',
      kind: 'fragment',
    });
  });

  it('logs and drops an inject for an unknown target', async () => {
    const ws = makeFakeWs();
    _registerTestConnection('node-1', ws);
    _handleIncomingMessage(
      JSON.stringify({
        type: 'inject',
        id: 'inj-1',
        target: 'missing',
        kind: 'fragment',
        content: 'x',
      }),
      'node-1'
    );
    await new Promise(r => setImmediate(r));
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('inject-remove fan-out', () => {
  it('forwards an inject-remove frame to the host beacon', async () => {
    createSwarmSession('sess-1', null, 'host-beacon');
    const hostWs = makeFakeWs();
    _registerTestConnection('host-beacon', hostWs);

    _handleIncomingMessage(
      JSON.stringify({
        type: 'inject-remove',
        target: 'sess-1',
        kind: 'fragment',
        injectionId: 'inj-1',
      }),
      'node-1'
    );

    await new Promise(r => setImmediate(r));
    const sent = lastCommand(hostWs);
    expect(sent.command).toBe('injectRemove');
    expect(sent.payload).toMatchObject({ target: 'sess-1', injectionId: 'inj-1' });
  });
});

describe('extension disconnect cleanup', () => {
  it('drops the manifest and cleans up injections on close', async () => {
    createSwarmSession('sess-1', null, 'host-beacon');
    const hostWs = makeFakeWs();
    _registerTestConnection('host-beacon', hostWs);
    const nodeWs = makeFakeWs();
    _registerTestConnection('node-1', nodeWs);

    _handleIncomingMessage(
      JSON.stringify({
        type: 'manifest',
        protocolVersion: 1,
        capabilities: [],
        bundles: [],
      }),
      'node-1'
    );
    _handleIncomingMessage(
      JSON.stringify({
        type: 'inject',
        id: 'inj-1',
        target: 'sess-1',
        kind: 'fragment',
        content: 'x',
      }),
      'node-1'
    );
    await new Promise(r => setImmediate(r));
    expect(getConnectedBeaconIds()).toContain('node-1');

    _disconnectTestConnection('node-1');
    await new Promise(r => setImmediate(r));

    expect(isExtension('node-1')).toBe(false);
    const sent = lastCommand(hostWs);
    expect(sent.command).toBe('injectRemove');
    expect(sent.payload).toMatchObject({
      extensionId: 'node-1',
      injectionId: 'inj-1',
    });
  });
});

describe('response frames still resolve pending commands', () => {
  it('resolves sendBeaconCommand from a response frame', async () => {
    const ws = makeFakeWs();
    _registerTestConnection('b1', ws);
    const promise = sendBeaconCommand('b1', 'spawn');
    const sent = JSON.parse(String(ws.send.mock.calls[0][0]));
    _handleIncomingMessage(
      JSON.stringify({ type: 'response', id: sent.id, ok: true, status: 200 })
    );
    await expect(promise).resolves.toEqual({ ok: true, status: 200 });
  });
});
