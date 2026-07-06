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
