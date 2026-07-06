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

describe('Knowledge Route Ordering', () => {
  it('GET /knowledge/search is not shadowed by /knowledge/:id', async () => {
    // Create a knowledge entry with id 'search' to test the shadowing scenario
    await app.inject({
      method: 'POST',
      url: '/knowledge',
      payload: { id: 'search', type: 'fact', key: 'test', value: 'test-value' },
    });
    // GET /knowledge/search?q=test should return search results, not the 'search' entry
    const res = await app.inject({
      method: 'GET',
      url: '/knowledge/search?q=test',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should be an array of search results, not a single object
    expect(Array.isArray(body)).toBe(true);
  });
});

describe('Swarm Large Payload', () => {
  it('POST /sync/events/push handles large payloads via blob storage', async () => {
    // Create a session first
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss-large', beaconId: 'b1' },
    });
    // Push an event with a payload > 10KB to exercise blob storage
    const largePayload = 'x'.repeat(11 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/sync/events/push',
      payload: {
        events: [
          {
            id: 'e-large',
            sessionId: 'ss-large',
            type: 'msg',
            payload: largePayload,
            createdAt: Date.now(),
          },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.count).toBe(1);
    // The payload should have been stored as a blob reference
    expect(body.events[0].payload).toMatch(/^blob:/);
  });
});

describe('Session Pipeline Status Transitions', () => {
  it('POST /sessions/:id/process returns 409 for wrong state', async () => {
    // Create a session
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss-409', beaconId: 'b1' },
    });
    // Process it
    await app.inject({ method: 'POST', url: '/sessions/ss-409/process' });
    // Try to process again — should fail because status is now 'processing'
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/ss-409/process',
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST /sessions/:id/processed returns 409 for wrong state', async () => {
    // Try to mark as processed without going through 'processing' first
    await app.inject({
      method: 'POST',
      url: '/sync/sessions/register',
      payload: { id: 'ss-409b', beaconId: 'b1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/sessions/ss-409b/processed',
    });
    expect(res.statusCode).toBe(409);
  });
});
