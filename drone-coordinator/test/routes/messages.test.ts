import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import type { FastifyInstance } from 'fastify';
import { sendBeaconCommand } from '../../src/beacon-ws.js';

vi.mock('../../src/beacon-ws.js', () => ({
  sendBeaconCommand: vi.fn(),
}));

let app: FastifyInstance;
const mockSend = vi.mocked(sendBeaconCommand);

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
    mockSend.mockResolvedValue({ ok: true, body: {} });
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

  it('POST /messages/relay happy path', async () => {
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
    mockSend.mockResolvedValue({ ok: true, body: { id: 'm1' } });

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
    mockSend.mockResolvedValue({
      ok: false,
      body: { error: 'error details' },
    });

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

  it('POST /messages/relay returns 503 when sendBeaconCommand throws', async () => {
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
    mockSend.mockRejectedValue(new Error('Beacon not connected'));

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

  it('POST /messages/broadcast with mixed results', async () => {
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
    mockSend
      .mockResolvedValueOnce({ ok: true, body: {} })
      .mockRejectedValueOnce(new Error('unreachable'));

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
