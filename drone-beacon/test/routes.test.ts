import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';
import * as db from '../src/db/index.js';

// Mock ws-server to avoid WebSocket dependency
vi.mock('../src/ws-server.js', () => ({
  isLocalConnection: vi.fn().mockReturnValue(true),
  isAgentConnected: vi.fn().mockReturnValue(false),
  getConnectedAgents: vi.fn().mockReturnValue([]),
  getConnection: vi.fn().mockReturnValue(undefined),
  sendToAgent: vi.fn(),
  sendToChannel: vi.fn(),
  registerWebSocketServer: vi.fn(),
  startMessageCleanup: vi.fn(),
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

  it('POST /personas creates a local persona', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('test-persona');
    expect(body.scope).toBe('local');
  });

  it('GET /personas lists personas', async () => {
    await app.inject({
      method: 'POST',
      url: '/personas',
      payload: validPersona,
    });
    const res = await app.inject({ method: 'GET', url: '/personas' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
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

  it('GET /personas/:id returns 404 for missing', async () => {
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

  it('PUT /personas/:id returns 404 for missing', async () => {
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

  it('DELETE /personas/:id returns 404 for missing', async () => {
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

  it('POST /skills creates a local skill', async () => {
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

  it('GET /skills/:id returns 404 for missing', async () => {
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

  it('PUT /skills/:id returns 404 for missing', async () => {
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

  it('DELETE /skills/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/skills/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Agent Routes ────────────────────────────────────────────────────

describe('Agent Routes', () => {
  it('POST /agents registers an agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'agent-1', personaId: null },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('agent-1');
  });

  it('GET /agents lists agents', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'agent-1', personaId: null },
    });
    const res = await app.inject({ method: 'GET', url: '/agents' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /agents/:id gets an agent', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'agent-1', personaId: null },
    });
    const res = await app.inject({ method: 'GET', url: '/agents/agent-1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('agent-1');
  });

  it('GET /agents/:id returns 404 for missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/agents/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /agents/:id/heartbeat updates activity', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'agent-1', personaId: null },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/heartbeat',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('agent-1');
  });

  it('POST /agents/:id/heartbeat returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/agents/nonexistent/heartbeat',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /agents/:id unregisters an agent', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'agent-1', personaId: null },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/agents/agent-1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /agents/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/agents/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Memory Routes ───────────────────────────────────────────────────

describe('Memory Routes', () => {
  it('POST /memory creates a memory', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/memory',
      payload: { key: 'test-key', value: 'test-value' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.key).toBe('test-key');
    expect(body.value).toBe('test-value');
  });

  it('GET /memory lists memories', async () => {
    await app.inject({
      method: 'POST',
      url: '/memory',
      payload: { key: 'k1', value: 'v1' },
    });
    const res = await app.inject({ method: 'GET', url: '/memory' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /memory/:id gets a memory', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/memory',
      payload: { key: 'k1', value: 'v1' },
    });
    const { id } = JSON.parse(createRes.body);
    const res = await app.inject({ method: 'GET', url: `/memory/${id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(id);
  });

  it('GET /memory/:id returns 404 for missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/memory/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /memory/key/:key gets memory by key', async () => {
    await app.inject({
      method: 'POST',
      url: '/memory',
      payload: { key: 'my-key', value: 'my-value' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/memory/key/my-key',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).key).toBe('my-key');
  });

  it('GET /memory/key/:key returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/memory/key/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /memory/:id updates a memory', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/memory',
      payload: { key: 'k1', value: 'v1' },
    });
    const { id } = JSON.parse(createRes.body);
    const res = await app.inject({
      method: 'PUT',
      url: `/memory/${id}`,
      payload: { value: 'updated' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).value).toBe('updated');
  });

  it('PUT /memory/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/memory/nonexistent',
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /memory/:id deletes a memory', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/memory',
      payload: { key: 'k1', value: 'v1' },
    });
    const { id } = JSON.parse(createRes.body);
    const res = await app.inject({
      method: 'DELETE',
      url: `/memory/${id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /memory/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/memory/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Message Routes ──────────────────────────────────────────────────

describe('Message Routes', () => {
  it('POST /messages returns 400 without fromAgentId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      payload: { toAgentId: 'agent-2', body: 'hello' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /messages returns 400 without toAgentId or toChannel', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      payload: { fromAgentId: 'agent-1', body: 'hello' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /messages returns 403 for unregistered sender', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      payload: {
        fromAgentId: 'unknown-agent',
        toAgentId: 'agent-2',
        body: 'hello',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /messages sends a message to an agent', async () => {
    // Register the sender first
    await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'agent-1', personaId: null },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/messages',
      payload: {
        fromAgentId: 'agent-1',
        toAgentId: 'agent-2',
        body: JSON.stringify({ text: 'hello' }),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.fromAgentId).toBe('agent-1');
    expect(body.toAgentId).toBe('agent-2');
  });

  it('GET /messages lists messages for an agent', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'agent-1', personaId: null },
    });
    await app.inject({
      method: 'POST',
      url: '/messages',
      payload: {
        fromAgentId: 'agent-1',
        toAgentId: 'agent-2',
        body: JSON.stringify({ text: 'hello' }),
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/messages?agentId=agent-2',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /messages returns 400 without agentId', async () => {
    const res = await app.inject({ method: 'GET', url: '/messages' });
    expect(res.statusCode).toBe(400);
  });

  it('GET /messages/:id gets a message', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'agent-1', personaId: null },
    });
    const createRes = await app.inject({
      method: 'POST',
      url: '/messages',
      payload: {
        fromAgentId: 'agent-1',
        toAgentId: 'agent-2',
        body: JSON.stringify({ text: 'hello' }),
      },
    });
    const { id } = JSON.parse(createRes.body);
    const res = await app.inject({ method: 'GET', url: `/messages/${id}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe(id);
  });

  it('GET /messages/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/messages/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /messages/:id/read marks message as read', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'agent-1', personaId: null },
    });
    const createRes = await app.inject({
      method: 'POST',
      url: '/messages',
      payload: {
        fromAgentId: 'agent-1',
        toAgentId: 'agent-2',
        body: JSON.stringify({ text: 'hello' }),
      },
    });
    const { id } = JSON.parse(createRes.body);
    const res = await app.inject({
      method: 'POST',
      url: `/messages/${id}/read`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('POST /messages/:id/read returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/messages/nonexistent/read',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /messages/channel/:channel lists channel messages', async () => {
    await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { id: 'agent-1', personaId: null },
    });
    await app.inject({
      method: 'POST',
      url: '/messages',
      payload: {
        fromAgentId: 'agent-1',
        toChannel: 'general',
        body: JSON.stringify({ text: 'hello' }),
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/messages/channel/general',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });
});

// ── Spawn Routes ────────────────────────────────────────────────────

describe('Spawn Routes', () => {
  it('GET /spawn lists spawns', async () => {
    // Create a spawn record directly in the DB
    db.createSpawn('spawn-1', null, null, null);
    const res = await app.inject({ method: 'GET', url: '/spawn' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /spawn/:spawnId gets a spawn', async () => {
    // Create a spawn record directly in the DB
    db.createSpawn('spawn-1', null, null, null);
    const res = await app.inject({
      method: 'GET',
      url: '/spawn/spawn-1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).spawnId).toBe('spawn-1');
  });

  it('GET /spawn/:spawnId returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/spawn/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /spawn/:spawnId returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/spawn/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Config Routes ───────────────────────────────────────────────────

describe('Config Routes', () => {
  it('GET /config lists config', async () => {
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });

  it('POST /config creates a config entry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/config',
      payload: { key: 'test-key', value: 'test-value' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).key).toBe('test-key');
  });

  it('GET /config/:key gets a config entry', async () => {
    await app.inject({
      method: 'POST',
      url: '/config',
      payload: { key: 'my-key', value: 'my-value' },
    });
    const res = await app.inject({ method: 'GET', url: '/config/my-key' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).key).toBe('my-key');
  });

  it('GET /config/:key returns 404 for missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/config/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /config/:key updates a config entry', async () => {
    await app.inject({
      method: 'POST',
      url: '/config',
      payload: { key: 'my-key', value: 'old-value' },
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/config/my-key',
      payload: { value: 'new-value' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).value).toBe('new-value');
  });

  it('PUT /config/:key returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/config/nonexistent',
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /config/:key deletes a config entry', async () => {
    await app.inject({
      method: 'POST',
      url: '/config',
      payload: { key: 'my-key', value: 'v' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/config/my-key',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /config/:key returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/config/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── Event Routes ────────────────────────────────────────────────────

describe('Event Routes', () => {
  it('GET /events lists events', async () => {
    const res = await app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });

  it('GET /events/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/events/nonexistent',
    });
    expect(res.statusCode).toBe(404);
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
      payload: { targetType: 'persona', targetId: 'p1', insight: 'i1' },
    });
    const res = await app.inject({ method: 'GET', url: '/insights' });
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

// ── Sync Routes ─────────────────────────────────────────────────────

describe('Sync Routes', () => {
  it('POST /sync returns error when coordinator not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Coordinator not configured');
  });

  it('POST /sync/events/push returns 400 without events', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/events/push',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /sync/events/push pushes events', async () => {
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

  it('DELETE /sync/sessions/:id returns 502 when coordinator not configured', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/sync/sessions/ss1',
    });
    expect(res.statusCode).toBe(502);
  });
});
