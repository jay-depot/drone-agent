import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp({ rateLimitMax: 3, rateLimitWindowMs: 60000 });
});

afterEach(async () => {
  await app.close();
  await teardownDb();
});

describe('Rate limiting', () => {
  it('allows requests under the limit', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('returns 429 once the limit is exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'GET', url: '/health' });
    }
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(429);
  });
});
