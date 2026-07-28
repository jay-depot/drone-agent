import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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

describe('Beacon Routes', () => {
  it('POST /beacons registers a beacon without publicKey', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).id).toBe('b1');
  });

  it('POST /beacons registers a beacon with publicKey (auto-approved for localhost)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: {
        id: 'b2',
        name: 'B2',
        host: 'localhost',
        port: 3457,
        publicKey: 'key1',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('approved');
  });

  it('POST /beacons with publicKey mismatch returns 403', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: {
        id: 'b3',
        name: 'B3',
        host: 'localhost',
        port: 3457,
        publicKey: 'key1',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: {
        id: 'b3',
        name: 'B3',
        host: 'localhost',
        port: 3457,
        publicKey: 'key2',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /beacons lists beacons with trust status', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    const res = await app.inject({ method: 'GET', url: '/api/beacons' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].trustStatus).toBeDefined();
  });

  it('GET /beacons/:id returns beacon with trust info', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    const res = await app.inject({ method: 'GET', url: '/api/beacons/b1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.beaconId).toBe('b1');
  });

  it('GET /beacons/:id returns 404 for missing beacon', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/beacons/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Beacon Trust Routes ──

  it('POST /beacons/trust registers trust', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust',
      payload: {
        id: 'b1',
        name: 'B1',
        host: 'localhost',
        port: 3457,
        publicKey: 'key1',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).status).toBe('approved');
  });

  it('POST /beacons/trust with public key mismatch returns 403', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons/trust',
      payload: {
        id: 'b1',
        name: 'B1',
        host: 'localhost',
        port: 3457,
        publicKey: 'key1',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust',
      payload: {
        id: 'b1',
        name: 'B1',
        host: 'localhost',
        port: 3457,
        publicKey: 'key2',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /beacons/trust lists trust records', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons/trust',
      payload: {
        id: 'b1',
        name: 'B1',
        host: 'localhost',
        port: 3457,
        publicKey: 'key1',
      },
    });
    const res = await app.inject({ method: 'GET', url: '/api/beacons/trust' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /beacons/trust/:id returns trust status', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons/trust',
      payload: {
        id: 'b1',
        name: 'B1',
        host: 'localhost',
        port: 3457,
        publicKey: 'key1',
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/beacons/trust/b1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('approved');
  });

  it('GET /beacons/trust/:id returns 404 for missing trust', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/beacons/trust/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /beacons/trust/:id deletes trust', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons/trust',
      payload: {
        id: 'b1',
        name: 'B1',
        host: 'localhost',
        port: 3457,
        publicKey: 'key1',
      },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/beacons/trust/b1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /beacons/trust/:id returns 404 for missing trust', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/beacons/trust/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Approval Routes ──

  it('POST /beacons/approve approves a pending beacon by token', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust',
      payload: {
        id: 'b1',
        name: 'B1',
        host: '10.0.0.1',
        port: 3457,
        publicKey: 'key1',
      },
    });
    const { approvalToken } = JSON.parse(createRes.body);
    expect(approvalToken).toBeTruthy();

    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/approve',
      payload: { approvalToken },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('POST /beacons/approve returns 400 without approvalToken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/approve',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /beacons/approve returns 404 for invalid token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/approve',
      payload: { approvalToken: 'invalid-token' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /beacons/trust/:id/reject rejects a beacon', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons/trust',
      payload: {
        id: 'b1',
        name: 'B1',
        host: '10.0.0.1',
        port: 3457,
        publicKey: 'key1',
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust/b1/reject',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('POST /beacons/trust/:id/reject returns 404 for missing trust', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/trust/nonexistent/reject',
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Beacon Session Routes ──

  it('POST /beacons/:id/sessions creates a session', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/b1/sessions',
      payload: { id: 's1', agentId: 'agent-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).id).toBe('s1');
  });

  it('POST /beacons/:id/sessions returns 404 for missing beacon', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/beacons/nonexistent/sessions',
      payload: { id: 's1', agentId: 'agent-1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /beacons/:id/sessions lists sessions', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/beacons/b1/sessions',
      payload: { id: 's1', agentId: 'agent-1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/beacons/b1/sessions',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /beacons/:id/sessions returns 404 for missing beacon', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/beacons/nonexistent/sessions',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /beacons/:id/sessions/:agentId gets a session', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/beacons/b1/sessions',
      payload: { id: 's1', agentId: 'agent-1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/beacons/b1/sessions/agent-1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('s1');
  });

  it('GET /beacons/:id/sessions/:agentId returns 404 for missing session', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/beacons/b1/sessions/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /beacons/:id/sessions/:agentId ends a session', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/beacons/b1/sessions',
      payload: { id: 's1', agentId: 'agent-1' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/beacons/b1/sessions/agent-1',
      payload: { disconnectedAt: 1000, durationMs: 5000 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.disconnectedAt).toBe(1000);
    expect(body.durationMs).toBe(5000);
  });

  it('DELETE /beacons/:id/sessions/:agentId returns 404 for missing session', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/beacons/b1/sessions/nonexistent',
      payload: { disconnectedAt: 1000, durationMs: 5000 },
    });
    expect(res.statusCode).toBe(404);
  });
});
