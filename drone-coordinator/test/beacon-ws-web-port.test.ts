import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { AddressInfo } from 'node:net';
import { setupDb, teardownDb } from './setup.js';
import {
  registerBeaconWebSocket,
  isBeaconConnected,
  resetBeaconConnections,
} from '../src/beacon-ws.js';
import { registerBeaconTrust } from '../src/db/index.js';

const NodeWebSocket = globalThis.WebSocket;

let app: FastifyInstance;
let wsUrl = '';

beforeEach(async () => {
  resetBeaconConnections();
  await setupDb();
  app = fastify({ logger: false });
  await app.register(websocket);
  registerBeaconWebSocket(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${address.port}/ws/beacon`;
});

afterEach(async () => {
  resetBeaconConnections();
  await app.close();
  await teardownDb();
});

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function awaitClose(ws: InstanceType<typeof NodeWebSocket>): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no close event')), 5000);
    ws.addEventListener('close', (ev: CloseEvent) => {
      clearTimeout(timer);
      resolve(ev.code);
    });
  });
}

describe('/ws/beacon on the unencrypted web port', () => {
  it('registers the route on the web app', () => {
    expect(app.hasRoute({ method: 'GET', url: '/ws/beacon' })).toBe(true);
  });

  it('admits a certificate-less socket that claims an approved node id', async () => {
    registerBeaconTrust(
      { id: 'node-1', name: 'Node 1', host: '127.0.0.1', publicKey: 'k' },
      { socketIsLocal: true }
    );
    const ws = new NodeWebSocket(`${wsUrl}?beaconId=node-1`);
    try {
      await waitFor(() => isBeaconConnected('node-1'));
      expect(isBeaconConnected('node-1')).toBe(true);
    } finally {
      ws.close();
    }
  });

  it('closes 4001 for an unknown claimed id', async () => {
    const ws = new NodeWebSocket(`${wsUrl}?beaconId=nope`);
    await expect(awaitClose(ws)).resolves.toBe(4001);
  });

  it('closes 4001 when no id is claimed at all', async () => {
    const ws = new NodeWebSocket(wsUrl);
    await expect(awaitClose(ws)).resolves.toBe(4001);
  });

  it('closes 4002 for a known but unapproved node', async () => {
    registerBeaconTrust({
      id: 'node-2',
      name: 'Node 2',
      host: '10.0.0.1',
      publicKey: 'k2',
    });
    const ws = new NodeWebSocket(`${wsUrl}?beaconId=node-2`);
    await expect(awaitClose(ws)).resolves.toBe(4002);
  });
});
