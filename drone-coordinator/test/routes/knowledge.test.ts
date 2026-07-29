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
      url: '/api/knowledge',
      payload: validKnowledge,
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).id).toBe('k1');
  });

  it('GET /knowledge lists knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({ method: 'GET', url: '/api/knowledge' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /knowledge?type=fact filters by type', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: validKnowledge,
    });
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: {
        id: 'k2',
        type: 'preference',
        key: 'pref-key',
        value: 'pref-value',
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge?type=fact',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /knowledge/:id gets knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/k1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('k1');
  });

  it('GET /knowledge/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT /knowledge/:id updates knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/knowledge/k1',
      payload: { value: 'updated-value' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).value).toBe('updated-value');
  });

  it('PUT /knowledge/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/knowledge/nonexistent',
      payload: { value: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /knowledge/:id deletes knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/knowledge/k1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
  });

  it('DELETE /knowledge/:id returns 404 for missing', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/knowledge/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /knowledge/search searches knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge/search?q=test',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /knowledge/search without q returns all', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/knowledge/search',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('POST /sync/knowledge/push upserts knowledge', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sync/knowledge/push',
      payload: validKnowledge,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('k1');
  });

  it('GET /sync/knowledge/pull pulls knowledge', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sync/knowledge/pull',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(1);
  });

  it('GET /sync/knowledge/pull?since= filters by updatedAt', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      payload: validKnowledge,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/sync/knowledge/pull?since=' + (Date.now() + 10000),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).length).toBe(0);
  });
});
