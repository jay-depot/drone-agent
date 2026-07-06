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
