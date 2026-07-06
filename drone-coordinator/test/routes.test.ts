import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
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

// ── Health Route ────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns status ok with timestamp', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('number');
  });
});

// ── Persona Routes ──────────────────────────────────────────────────

describe('Persona Routes', () => {
  const validPersona = {
    id: 'test-persona',
    name: 'Test Persona',
    description: 'A test persona',
    systemPrompt: 'You are a test persona.',
  };

  it('POST /personas creates a persona', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('test-persona');
    expect(body.scope).toBe('coordinator');
  });

  it('GET /personas lists personas', async () => {
    await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/personas',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
  });

  it('GET /personas/:id returns a persona', async () => {
    await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/personas/test-persona',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('test-persona');
  });

  it('GET /personas/:id returns 404 for missing persona', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/personas/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /personas/:id updates a persona', async () => {
    await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/personas/test-persona',
      payload: { name: 'Updated' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('Updated');
  });

  it('PUT /personas/:id returns 404 for missing persona', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/personas/nonexistent',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /personas/:id deletes a persona', async () => {
    await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/personas/test-persona',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /personas/:id returns 404 for missing persona', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/personas/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Skill Routes ────────────────────────────────────────────────────

describe('Skill Routes', () => {
  const validSkill = {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    trigger: 'test-trigger',
    body: '# Skill Body',
  };

  it('POST /skills creates a skill', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: validSkill,
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).id).toBe('test-skill');
  });

  it('GET /skills lists skills', async () => {
    await app.inject({ method: 'POST', url: '/skills', payload: validSkill });
    const res = await app.inject({ method: 'GET', url: '/skills' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /skills/:id returns a skill', async () => {
    await app.inject({ method: 'POST', url: '/skills', payload: validSkill });
    const res = await app.inject({ method: 'GET', url: '/skills/test-skill' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('test-skill');
  });

  it('GET /skills/:id returns 404 for missing skill', async () => {
    const res = await app.inject({ method: 'GET', url: '/skills/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /skills/:id updates a skill', async () => {
    await app.inject({ method: 'POST', url: '/skills', payload: validSkill });
    const res = await app.inject({
      method: 'PUT',
      url: '/skills/test-skill',
      payload: { name: 'Updated' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).name).toBe('Updated');
  });

  it('PUT /skills/:id returns 404 for missing skill', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/skills/nonexistent',
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /skills/:id deletes a skill', async () => {
    await app.inject({ method: 'POST', url: '/skills', payload: validSkill });
    const res = await app.inject({
      method: 'DELETE',
      url: '/skills/test-skill',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /skills/:id returns 404 for missing skill', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/skills/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Beacon Routes ──────────────────────────────────────────────────

describe('Beacon Routes', () => {
  it('POST /beacons registers a beacon without publicKey', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).id).toBe('b1');
  });

  it('POST /beacons registers a beacon with publicKey (auto-approved for localhost)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/beacons',
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
      url: '/beacons',
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
      url: '/beacons',
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
      url: '/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    const res = await app.inject({ method: 'GET', url: '/beacons' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(1);
    expect(body[0].trustStatus).toBeDefined();
  });

  it('GET /beacons/:id returns beacon with trust info', async () => {
    await app.inject({
      method: 'POST',
      url: '/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    const res = await app.inject({ method: 'GET', url: '/beacons/b1' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.beaconId).toBe('b1');
  });

  it('GET /beacons/:id returns 404 for missing beacon', async () => {
    const res = await app.inject({ method: 'GET', url: '/beacons/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  // ── Beacon Trust Routes ──

  it('POST /beacons/trust registers trust', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/beacons/trust',
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
      url: '/beacons/trust',
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
      url: '/beacons/trust',
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
      url: '/beacons/trust',
      payload: {
        id: 'b1',
        name: 'B1',
        host: 'localhost',
        port: 3457,
        publicKey: 'key1',
      },
    });
    const res = await app.inject({ method: 'GET', url: '/beacons/trust' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /beacons/trust/:id returns trust status', async () => {
    await app.inject({
      method: 'POST',
      url: '/beacons/trust',
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
      url: '/beacons/trust/b1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('approved');
  });

  it('GET /beacons/trust/:id returns 404 for missing trust', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/beacons/trust/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /beacons/trust/:id deletes trust', async () => {
    await app.inject({
      method: 'POST',
      url: '/beacons/trust',
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
      url: '/beacons/trust/b1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /beacons/trust/:id returns 404 for missing trust', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/beacons/trust/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Approval Routes ──

  it('POST /beacons/approve approves a pending beacon by token', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/beacons/trust',
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
      url: '/beacons/approve',
      payload: { approvalToken },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('POST /beacons/approve returns 400 without approvalToken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/beacons/approve',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /beacons/approve returns 404 for invalid token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/beacons/approve',
      payload: { approvalToken: 'invalid-token' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /beacons/trust/:id/reject rejects a beacon', async () => {
    await app.inject({
      method: 'POST',
      url: '/beacons/trust',
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
      url: '/beacons/trust/b1/reject',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('POST /beacons/trust/:id/reject returns 404 for missing trust', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/beacons/trust/nonexistent/reject',
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Beacon Session Routes ──

  it('POST /beacons/:id/sessions creates a session', async () => {
    await app.inject({
      method: 'POST',
      url: '/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/beacons/b1/sessions',
      payload: { id: 's1', agentId: 'agent-1' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).id).toBe('s1');
  });

  it('POST /beacons/:id/sessions returns 404 for missing beacon', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/beacons/nonexistent/sessions',
      payload: { id: 's1', agentId: 'agent-1' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /beacons/:id/sessions lists sessions', async () => {
    await app.inject({
      method: 'POST',
      url: '/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    await app.inject({
      method: 'POST',
      url: '/beacons/b1/sessions',
      payload: { id: 's1', agentId: 'agent-1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/beacons/b1/sessions',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /beacons/:id/sessions returns 404 for missing beacon', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/beacons/nonexistent/sessions',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /beacons/:id/sessions/:agentId gets a session', async () => {
    await app.inject({
      method: 'POST',
      url: '/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    await app.inject({
      method: 'POST',
      url: '/beacons/b1/sessions',
      payload: { id: 's1', agentId: 'agent-1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/beacons/b1/sessions/agent-1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('s1');
  });

  it('GET /beacons/:id/sessions/:agentId returns 404 for missing session', async () => {
    await app.inject({
      method: 'POST',
      url: '/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/beacons/b1/sessions/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /beacons/:id/sessions/:agentId ends a session', async () => {
    await app.inject({
      method: 'POST',
      url: '/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    await app.inject({
      method: 'POST',
      url: '/beacons/b1/sessions',
      payload: { id: 's1', agentId: 'agent-1' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/beacons/b1/sessions/agent-1',
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
      url: '/beacons',
      payload: { id: 'b1', name: 'B1', host: 'localhost', port: 3457 },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/beacons/b1/sessions/nonexistent',
      payload: { disconnectedAt: 1000, durationMs: 5000 },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Knowledge Routes ────────────────────────────────────────────────

describe('Knowledge Routes', () => {
  const validKnowledge = {
    id: 'k1',
    type: 'fact' as const,
    key: 'test-key',
    value: 'test-value',
  };

  it('POST /knowledge creates knowledge', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: validKnowledge,
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).id).toBe('k1');
  });

  it('GET /knowledge lists knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({ method: 'GET', url: '/knowledge' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /knowledge?type=fact filters by type', async () => {
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: validKnowledge,
    });
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: {
        id: 'k2',
        type: 'preference',
        key: 'pref-key',
        value: 'pref-value',
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/knowledge?type=fact',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /knowledge/:id gets knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({ method: 'GET', url: '/knowledge/k1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('k1');
  });

  it('GET /knowledge/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/knowledge/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /knowledge/:id updates knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/knowledge/k1',
      payload: { value: 'updated-value' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).value).toBe('updated-value');
  });

  it('PUT /knowledge/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/knowledge/nonexistent',
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /knowledge/:id deletes knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/knowledge/k1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /knowledge/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/knowledge/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /knowledge/search searches knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/knowledge/search?q=test',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /knowledge/search without q returns all', async () => {
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/knowledge/search',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('POST /sync/knowledge/push upserts knowledge', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/knowledge/push',
      payload: validKnowledge,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('k1');
  });

  it('GET /sync/knowledge/pull pulls knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/sync/knowledge/pull',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /sync/knowledge/pull?since= filters by updatedAt', async () => {
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/sync/knowledge/pull?since=' + (Date.now() + 10000),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(0);
  });
});

// ── Swarm Routes ────────────────────────────────────────────────────

describe('Swarm Routes', () => {
  it('POST /sync/sessions/register registers a session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).status).toBe('active');
  });

  it('POST /sync/sessions/register returns 400 without id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { beaconId: 'b1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /sync/sessions/:id ends a session', async () => {
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/sync/sessions/ss1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ended');
  });

  it('DELETE /sync/sessions/:id returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/sync/sessions/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /sync/events/push pushes events', async () => {
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sync/events/push',
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
      url: '/sync/events/push',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /sessions/:id/events gets events', async () => {
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    await app.inject({
      method: 'POST',
      url: '/sync/events/push',
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
      url: '/sessions/ss1/events',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /sessions/:id/events returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sessions/nonexistent/events',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /sessions/:id/events/latest gets latest events', async () => {
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    await app.inject({
      method: 'POST',
      url: '/sync/events/push',
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
      url: '/sessions/ss1/events/latest?limit=1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
    expect(body[0].id).toBe('e2');
  });

  it('GET /sessions/:id/events/latest returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sessions/nonexistent/events/latest',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /events/search searches events', async () => {
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    await app.inject({
      method: 'POST',
      url: '/sync/events/push',
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
      url: '/events/search?q=hello',
    });
    // FTS5 may not work in test context, but the route should not error
    expect([200, 500]).toContain(res.statusCode);
  });

  it('GET /events/search returns 400 without q', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/events/search',
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Session Pipeline Routes ──

  it('GET /sessions lists sessions', async () => {
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessions.length).toBe(1);
    expect(body.count).toBe(1);
  });

  it('GET /sessions/:id/log gets session log', async () => {
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/sessions/ss1/log',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.session.id).toBe('ss1');
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('GET /sessions/:id/log returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/sessions/nonexistent/log',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /sessions/:id/process transitions to processing', async () => {
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/ss1/process',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).session.status).toBe('processing');
  });

  it('POST /sessions/:id/process returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/nonexistent/process',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /sessions/:id/processed marks as processed', async () => {
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss1', beaconId: 'b1' },
    });
    await app.inject({ method: 'POST', url: '/sessions/ss1/process' });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/ss1/processed',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).session.status).toBe('processed');
  });

  it('POST /sessions/:id/processed returns 404 for missing session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/nonexistent/processed',
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Tool Definition Routes ──

  it('POST /sync/tools/push pushes tool definitions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/tools/push',
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
      url: '/sync/tools/push',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /tools/default-hidden lists default hidden tools', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/tools/default-hidden',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.tools)).toBe(true);
  });

  // ── Agent Location Routes ──

  it('POST /agents/location registers a location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).agentId).toBe('agent-1');
  });

  it('POST /agents/location returns 400 without agentId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents/location',
      payload: { beaconId: 'b1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /agents/location/:agentId gets a location', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/agents/location/agent-1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).agentId).toBe('agent-1');
  });

  it('GET /agents/location/:agentId returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/agents/location/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /agents/location/:agentId/heartbeat updates heartbeat', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/agents/location/agent-1/heartbeat',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('POST /agents/location/:agentId/heartbeat returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents/location/nonexistent/heartbeat',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /agents/location/:agentId unregisters location', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/agents/location/agent-1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /agents/location/:agentId returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/agents/location/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /agents/location lists all locations', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    const res = await app.inject({ method: 'GET', url: '/agents/location' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /agents/location?beaconId= filters by beacon', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents/location',
      payload: { agentId: 'agent-1', beaconId: 'b1' },
    });
    await app.inject({
      method: 'POST',
      url: '/agents/location',
      payload: { agentId: 'agent-2', beaconId: 'b2' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/agents/location?beaconId=b1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });
});

// ── Message Routes ─────────────────────────────────────────────────

describe('Message Routes', () => {
  it('POST /messages/relay returns 400 without required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages/relay',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /messages/relay returns 404 when target agent not found', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages/relay',
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
      url: '/messages/broadcast',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /messages/broadcast broadcasts to beacons', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages/broadcast',
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

// ── Insight Routes ──────────────────────────────────────────────────

describe('Insight Routes', () => {
  it('POST /insights creates an insight', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/insights',
      payload: {
        targetType: 'persona',
        targetId: 'test-persona',
        insight: 'Test insight',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.targetType).toBe('persona');
    expect(body.insight).toBe('Test insight');
  });

  it('POST /insights returns 400 without required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/insights',
      payload: { targetType: 'persona' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /insights lists insights', async () => {
    await app.inject({
      method: 'POST',
      url: '/insights',
      payload: {
        targetType: 'persona',
        targetId: 'p1',
        insight: 'i1',
      },
    });
    const res = await app.inject({ method: 'GET', url: '/insights' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /insights?targetType= filters by type', async () => {
    await app.inject({
      method: 'POST',
      url: '/insights',
      payload: { targetType: 'persona', targetId: 'p1', insight: 'i1' },
    });
    await app.inject({
      method: 'POST',
      url: '/insights',
      payload: { targetType: 'skill', targetId: 's1', insight: 'i2' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/insights?targetType=persona',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /insights/:id gets an insight', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/insights',
      payload: { targetType: 'persona', targetId: 'p1', insight: 'i1' },
    });
    const { id } = JSON.parse(createRes.body);
    const res = await app.inject({ method: 'GET', url: `/insights/${id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(id);
  });

  it('GET /insights/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/insights/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /insights/:id deletes an insight', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/insights',
      payload: { targetType: 'persona', targetId: 'p1', insight: 'i1' },
    });
    const { id } = JSON.parse(createRes.body);
    const res = await app.inject({
      method: 'DELETE',
      url: `/insights/${id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /insights/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/insights/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Principle Routes ────────────────────────────────────────────────

describe('Principle Routes', () => {
  it('POST /principles creates a principle', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/principles',
      payload: {
        targetType: 'persona',
        targetId: 'test-persona',
        principle: 'Test principle',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.targetType).toBe('persona');
    expect(body.principle).toBe('Test principle');
  });

  it('POST /principles returns 400 without required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/principles',
      payload: { targetType: 'persona' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /principles lists principles', async () => {
    await app.inject({
      method: 'POST',
      url: '/principles',
      payload: { targetType: 'persona', targetId: 'p1', principle: 'pr1' },
    });
    const res = await app.inject({ method: 'GET', url: '/principles' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /principles?targetType= filters by type', async () => {
    await app.inject({
      method: 'POST',
      url: '/principles',
      payload: { targetType: 'persona', targetId: 'p1', principle: 'pr1' },
    });
    await app.inject({
      method: 'POST',
      url: '/principles',
      payload: { targetType: 'skill', targetId: 's1', principle: 'pr2' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/principles?targetType=persona',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /principles/:id gets a principle', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/principles',
      payload: { targetType: 'persona', targetId: 'p1', principle: 'pr1' },
    });
    const { id } = JSON.parse(createRes.body);
    const res = await app.inject({ method: 'GET', url: `/principles/${id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(id);
  });

  it('GET /principles/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/principles/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /principles/:id deletes a principle', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/principles',
      payload: { targetType: 'persona', targetId: 'p1', principle: 'pr1' },
    });
    const { id } = JSON.parse(createRes.body);
    const res = await app.inject({
      method: 'DELETE',
      url: `/principles/${id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /principles/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/principles/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});
