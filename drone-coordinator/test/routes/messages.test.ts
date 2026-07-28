import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

describe('Message Routes', () => {
  it('POST /messages/relay returns 400 without required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/relay',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /messages/relay returns 404 when target agent not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/relay',
      payload: {
        fromBeaconId: 'b1',
        fromAgentId: 'agent-1',
        toAgentId: 'agent-2',
        body: 'hello',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('AGENT_NOT_FOUND');
  });

  it('POST /messages/broadcast returns 400 without required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/broadcast',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /messages/broadcast broadcasts to beacons', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/broadcast',
      payload: {
        fromAgentId: 'agent-1',
        channel: 'general',
        body: 'hello',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(typeof body.deliveredCount).toBe('number');
  });
});

describe('Message Routes (detailed)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST /messages/relay returns 503 when target beacon unavailable', async () => {
    // Register an agent location with a beacon that has no beacon row
    await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/relay',
      payload: {
        fromBeaconId: 'b-from',
        fromAgentId: 'agent-from',
        toAgentId: 'agent-1',
        body: 'hello',
      },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('BEACON_NOT_FOUND');
  });

  it('POST /messages/relay happy path with fetch stub', async () => {
    // Register a beacon and agent location
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: {
        id: 'b-target',
        name: 'Target',
        host: 'localhost',
        port: 3457,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-target', beaconId: 'b-target' },
    });
    // Stub fetch to return success
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'm1' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/relay',
      payload: {
        fromBeaconId: 'b-from',
        fromAgentId: 'agent-from',
        toAgentId: 'agent-target',
        body: 'hello',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.messageId).toBe('m1');
    expect(body.delivered).toBe(true);
  });

  it('POST /messages/relay returns 502 when target beacon returns error', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: {
        id: 'b-target',
        name: 'Target',
        host: 'localhost',
        port: 3457,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-target', beaconId: 'b-target' },
    });
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => 'error details',
    });
    vi.stubGlobal('fetch', mockFetch);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/relay',
      payload: {
        fromBeaconId: 'b-from',
        fromAgentId: 'agent-from',
        toAgentId: 'agent-target',
        body: 'hello',
      },
    });
    expect(res.statusCode).toBe(502);
  });

  it('POST /messages/relay returns 503 when fetch throws', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: {
        id: 'b-target',
        name: 'Target',
        host: 'localhost',
        port: 3457,
      },
    });
    await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-target', beaconId: 'b-target' },
    });
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error('Connection refused'));
    vi.stubGlobal('fetch', mockFetch);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/relay',
      payload: {
        fromBeaconId: 'b-from',
        fromAgentId: 'agent-from',
        toAgentId: 'agent-target',
        body: 'hello',
      },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe('BEACON_UNAVAILABLE');
  });

  it('POST /messages/broadcast with mixed fetch results', async () => {
    // Register two beacons
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b2', name: 'B2', host: '10.0.0.1', port: 3457 },
    });
    // Stub fetch: first call succeeds, second throws
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('unreachable'));
    vi.stubGlobal('fetch', mockFetch);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/broadcast',
      payload: {
        fromAgentId: 'agent-1',
        channel: 'general',
        body: 'hello',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.deliveredCount).toBe(1);
    expect(body.totalBeacons).toBe(2);
  });
});
