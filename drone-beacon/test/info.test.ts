import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';
import { setBeaconInfo } from '../src/beacon-info.js';

// ws-server imports the WebSocket plugin lazily; mock the message handlers'
// heavy dependencies so the real server can still be exercised.
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

describe('GET /info', () => {
  it('returns the configured beacon identity', async () => {
    setBeaconInfo({
      id: 'beacon-1',
      name: 'home-office',
      coordinatorHost: 'coord.example',
      coordinatorPort: 3456,
    });

    const res = await app.inject({ method: 'GET', url: '/info' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      id: 'beacon-1',
      name: 'home-office',
      coordinatorHost: 'coord.example',
      coordinatorPort: 3456,
    });
  });

  it('defaults to unknown identity with no coordinator', async () => {
    setBeaconInfo({
      id: 'unknown',
      name: 'unknown',
      coordinatorHost: null,
      coordinatorPort: null,
    });

    const res = await app.inject({ method: 'GET', url: '/info' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      id: 'unknown',
      name: 'unknown',
      coordinatorHost: null,
      coordinatorPort: null,
    });
  });
});

describe('WebSocket connected handshake', () => {
  it('includes the beacon info payload', async () => {
    setBeaconInfo({
      id: 'beacon-9',
      name: 'workshop',
      coordinatorHost: 'coord.example',
      coordinatorPort: 3456,
    });

    const { registerWebSocketServer } = await import('../src/ws-server.js');
    const { registerAgent } = await import('../src/db/index.js');
    registerAgent({ id: 'agent-1', personaId: null });

    await registerWebSocketServer(app, { enforceLocalOnly: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('server did not bind a port');
    }

    const { WebSocket } = await import('ws');
    const received = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${address.port}/ws?agentId=agent-1`
        );
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error('no connected message received'));
        }, 5000);
        socket.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (msg.type === 'connected') {
            clearTimeout(timer);
            socket.close();
            resolve(msg);
          }
        });
        socket.on('error', err => {
          clearTimeout(timer);
          reject(err);
        });
      }
    );

    expect(received.payload).toMatchObject({
      agentId: 'agent-1',
      info: {
        id: 'beacon-9',
        name: 'workshop',
        coordinatorHost: 'coord.example',
        coordinatorPort: 3456,
      },
    });
  });
});
