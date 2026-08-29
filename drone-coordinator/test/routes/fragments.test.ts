import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import type { FastifyInstance } from 'fastify';
import { upsertFragment } from '../../src/db/index.js';

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

describe('GET /api/fragments', () => {
  it('lists fragments with the coordinator scope normalized', async () => {
    upsertFragment({
      id: 'f1',
      target: 'broadcast',
      content: 'c',
      phase: 'header',
      scope: 'coordinator',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: null,
    });

    const res = await app.inject({ method: 'GET', url: '/api/fragments' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.fragments).toHaveLength(1);
    expect(body.fragments[0]).toMatchObject({
      id: 'f1',
      target: 'broadcast',
      scope: 'coordinator',
    });
  });

  it('filters by target query parameter', async () => {
    upsertFragment({
      id: 't1',
      target: 'agent-1',
      content: 'c',
      phase: 'header',
      scope: 'coordinator',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: null,
    });
    upsertFragment({
      id: 'b1',
      target: 'broadcast',
      content: 'c',
      phase: 'footer',
      scope: 'coordinator',
      createdAt: 1,
      updatedAt: 1,
      expiresAt: null,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/fragments?target=agent-1',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.fragments).toHaveLength(1);
    expect(body.fragments[0].id).toBe('t1');
  });

  it('returns an empty list when there are no fragments', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fragments' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).fragments).toEqual([]);
  });
});
