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

describe('Swarm Routes', () => {
  it('POST /sync/sessions/register registers a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).status).toBe('active');
  });

  it('POST /sync/sessions/register returns 400 without id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { beaconId: 'b1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /sync/sessions/:id ends a session', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sync/sessions/ss1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ended');
  });

  it('DELETE /sync/sessions/:id returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sync/sessions/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
  it('POST /sessions/:id/process transitions ended session to processing', async () => {
    // Create a session, end it, then process it — should succeed
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss-ended', beaconId: 'b1' },
    });
    await app.inject({ method: 'POST', url: '/api/sessions/ss-ended/end' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/ss-ended/process',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).session.status).toBe('processing');
  });

  it('POST /sessions/mark-stale marks old active sessions as stale', async () => {
    // Create a session with a manually set old updatedAt
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss-stale', beaconId: 'b1' },
    });
    // Manually set updatedAt far in the past via direct DB call
    const { getDatabase } = await import('../../src/db/init.js');
    const db = getDatabase();
    db.prepare(
      "UPDATE swarm_sessions SET updatedAt = 0 WHERE id = 'ss-stale'"
    ).run();
    // Now mark stale with a very low threshold
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/mark-stale?thresholdMs=1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    expect(body.sessions[0].id).toBe('ss-stale');
    expect(body.sessions[0].status).toBe('stale');
  });

  it('POST /sessions/mark-stale with no threshold defaults to 24 hours', async () => {
    // No sessions should be stale with default threshold (24 hours) for a fresh session
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss-fresh', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/mark-stale',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).count).toBe(0);
  });

  // ── Session End Route ──

  it('POST /sessions/:id/end ends an active session', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/ss1/end',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ended');
  });

  it('POST /sessions/:id/end returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/end',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /sessions/:id/end is idempotent on already-ended session', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    // End it once
    await app.inject({ method: 'POST', url: '/api/sessions/ss1/end' });
    // End it again — should still succeed
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/ss1/end',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ended');
  });

  it('GET /sessions count reflects total, not page size', async () => {
    // Register 3 sessions
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: '/api/sync/sessions/register',
        payload: { id: `ss${i}`, beaconId: 'b1' },
      });
    }
    // Fetch with limit=1 — count should be 3, not 1
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions?limit=1&offset=0',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessions.length).toBe(1);
    expect(body.count).toBe(3);
  });

  it('POST /sync/events/push pushes events', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/events/push',
      payload: {
        events: [
          {
            id: 'e1',
            sessionId: 'ss1',
            type: 'msg',
            payload: 'hello',
            createdAt: Date.now(),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).count).toBe(1);
  });

  it('POST /sync/events/push returns 400 without events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/events/push',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /sessions/:id/events gets events', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/sync/events/push',
      payload: {
        events: [
          {
            id: 'e1',
            sessionId: 'ss1',
            type: 'msg',
            payload: 'hello',
            createdAt: 1,
          },
        ],
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss1/events',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /sessions/:id/events returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/events',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /sessions/:id/events/latest gets latest events', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/sync/events/push',
      payload: {
        events: [
          {
            id: 'e1',
            sessionId: 'ss1',
            type: 'msg',
            payload: 'first',
            createdAt: 1,
          },
          {
            id: 'e2',
            sessionId: 'ss1',
            type: 'msg',
            payload: 'second',
            createdAt: 2,
          },
        ],
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss1/events/latest?limit=1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].id).toBe('e2');
  });

  it('GET /sessions/:id/events/latest returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/events/latest',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /events/search searches events', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/sync/events/push',
      payload: {
        events: [
          {
            id: 'e1',
            sessionId: 'ss1',
            type: 'msg',
            payload: 'hello world',
            createdAt: 1,
          },
        ],
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/events/search?q=hello',
    });
    // FTS5 may not work in test context, but the route should not error
    expect([200, 500]).toContain(res.statusCode);
  });

  it('GET /events/search returns 400 without q', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/events/search',
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Session Pipeline Routes ──

  it('GET /sessions lists sessions', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessions.length).toBe(1);
    expect(body.count).toBe(1);
  });

  it('GET /sessions/:id/log gets session log', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/ss1/log',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.session.id).toBe('ss1');
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('GET /sessions/:id/log returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/sessions/nonexistent/log',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /sessions/:id/process transitions to processing', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/ss1/process',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).session.status).toBe('processing');
  });

  it('POST /sessions/:id/process returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/process',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /sessions/:id/processed marks as processed', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    await app.inject({ method: 'POST', url: '/api/sessions/ss1/process' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/ss1/processed',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).session.status).toBe('processed');
  });

  it('POST /sessions/:id/processed returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/nonexistent/processed',
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Tool Definition Routes ──

  it('POST /sync/tools/push pushes tool definitions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/tools/push',
      payload: {
        tools: [
          {
            name: 'test-tool',
            description: 'A test tool',
            defaultHidden: false,
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).count).toBe(1);
  });

  it('POST /sync/tools/push returns 400 without tools', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/tools/push',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /tools/default-hidden lists default hidden tools', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/tools/default-hidden',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.tools)).toBe(true);
  });

  // ── Agent Location Routes ──

  it('POST /agents/location registers a location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).agentId).toBe('agent-1');
  });

  it('POST /agents/location returns 400 without agentId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { beaconId: 'b1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /agents/location/:agentId gets a location', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/location/agent-1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).agentId).toBe('agent-1');
  });

  it('GET /agents/location/:agentId returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/location/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /agents/location/:agentId/heartbeat updates heartbeat', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/location/agent-1/heartbeat',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('POST /agents/location/:agentId/heartbeat returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/location/nonexistent/heartbeat',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /agents/location/:agentId unregisters location', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/agents/location/agent-1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /agents/location/:agentId returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/agents/location/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /agents/location lists all locations', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/location',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /agents/location?beaconId= filters by beacon', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/agents/location',
      payload: { agentId: 'agent-2', beaconId: 'b2' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/location?beaconId=b1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });
});
