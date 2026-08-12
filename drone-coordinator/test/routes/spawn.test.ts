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

describe('Spawn Route', () => {
  function mockResolve(value: {
    ok: boolean;
    status?: number;
    body?: unknown;
  }) {
    mockSend.mockResolvedValue(value);
  }
  function mockReject(err: Error) {
    mockSend.mockRejectedValue(err);
  }

  it('POST /spawn forwards request to beacon and returns result', async () => {
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

    mockResolve({
      ok: true,
      body: {
        spawnId: 'spawn-123',
        agentId: 'agent-abc',
        status: 'spawning',
        beaconUrl: 'http://localhost:3457',
        message: 'Agent spawned, waiting for connection',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/spawn',
      payload: {
        targetBeaconId: 'b-target',
        personaId: 'test-persona',
        task: 'do something',
        spawnId: 'my-spawn-id',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.spawnId).toBe('spawn-123');
    expect(body.agentId).toBe('agent-abc');
    expect(body.status).toBe('spawning');
    expect(body.targetBeaconId).toBe('b-target');

    expect(mockSend).toHaveBeenCalledWith(
      'b-target',
      'spawn',
      expect.objectContaining({ personaId: 'test-persona' })
    );
  });

  it('POST /spawn returns 400 when targetBeaconId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/spawn',
      payload: { personaId: 'test' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('targetBeaconId');
  });

  it('POST /spawn returns 404 when beacon not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/spawn',
      payload: { targetBeaconId: 'nonexistent' },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('BEACON_NOT_FOUND');
  });

  it('POST /spawn returns 502 when beacon returns error', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b-error', name: 'Error', host: 'localhost', port: 3457 },
    });

    mockResolve({
      ok: false,
      status: 502,
      body: { error: 'Persona not found: bad-persona' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/spawn',
      payload: { targetBeaconId: 'b-error' },
    });
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Beacon error');
    expect(body.details).toBe('Persona not found: bad-persona');
  });

  it('POST /spawn returns 503 when beacon is unreachable', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b-down', name: 'Down', host: 'localhost', port: 3457 },
    });

    mockReject(new Error('Beacon not connected via reverse channel'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/spawn',
      payload: { targetBeaconId: 'b-down' },
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('BEACON_UNAVAILABLE');
  });

  // ── GET /spawn/:beaconId ──────────────────────────────────────────

  it('GET /spawn/:beaconId lists spawns on a beacon', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b-list', name: 'List', host: 'localhost', port: 3457 },
    });

    mockResolve({
      ok: true,
      body: [
        { id: 's1', status: 'running' },
        { id: 's2', status: 'failed' },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/spawn/b-list',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it('GET /spawn/:beaconId passes status query param', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: {
        id: 'b-filter',
        name: 'Filter',
        host: 'localhost',
        port: 3457,
      },
    });

    mockResolve({
      ok: true,
      body: [{ id: 's1', status: 'running' }],
    });

    await app.inject({
      method: 'GET',
      url: '/api/spawn/b-filter?status=running',
    });

    expect(mockSend).toHaveBeenCalledWith('b-filter', 'listSpawns', {
      status: 'running',
    });
  });

  it('GET /spawn/:beaconId returns 404 when beacon not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/spawn/nonexistent',
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('BEACON_NOT_FOUND');
  });

  it('GET /spawn/:beaconId returns 502 when beacon returns error', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b-err', name: 'Err', host: 'localhost', port: 3457 },
    });

    mockResolve({ ok: false, status: 502, body: { error: 'Internal error' } });

    const res = await app.inject({
      method: 'GET',
      url: '/api/spawn/b-err',
    });
    expect(res.statusCode).toBe(502);
  });

  it('GET /spawn/:beaconId returns 503 when beacon unreachable', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b-gone', name: 'Gone', host: 'localhost', port: 3457 },
    });

    mockReject(new Error('timeout'));

    const res = await app.inject({
      method: 'GET',
      url: '/api/spawn/b-gone',
    });
    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('BEACON_UNAVAILABLE');
  });

  // ── GET /spawn/:beaconId/:spawnId ─────────────────────────────────

  it('GET /spawn/:beaconId/:spawnId returns spawn status', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: {
        id: 'b-status',
        name: 'Status',
        host: 'localhost',
        port: 3457,
      },
    });

    mockResolve({
      ok: true,
      body: {
        spawnId: 's1',
        agentId: 'agent-abc',
        status: 'running',
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/spawn/b-status/s1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.spawnId).toBe('s1');
    expect(body.status).toBe('running');
    expect(mockSend).toHaveBeenCalledWith('b-status', 'getSpawn', {
      spawnId: 's1',
    });
  });

  it('GET /spawn/:beaconId/:spawnId returns 404 when beacon not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/spawn/nonexistent/s1',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('BEACON_NOT_FOUND');
  });

  // ── DELETE /spawn/:beaconId/:spawnId ──────────────────────────────

  it('DELETE /spawn/:beaconId/:spawnId terminates a spawned agent', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b-term', name: 'Term', host: 'localhost', port: 3457 },
    });

    mockResolve({
      ok: true,
      body: { success: true, message: 'Termination signal sent' },
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/spawn/b-term/s1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(mockSend).toHaveBeenCalledWith('b-term', 'terminateSpawn', {
      spawnId: 's1',
    });
  });

  it('DELETE /spawn/:beaconId/:spawnId returns 404 when beacon not found', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/spawn/nonexistent/s1',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe('BEACON_NOT_FOUND');
  });
});
