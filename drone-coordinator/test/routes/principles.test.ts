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
