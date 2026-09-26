import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from '../setup.js';
import { buildTestApp } from '../app-helper.js';
import type { FastifyInstance } from 'fastify';
import { upsertFragment, listFragments } from '../../src/db/index.js';
import { notifyFragmentsChanged } from '../../src/beacon-ws.js';

vi.mock('../../src/beacon-ws.js', () => ({
  notifyFragmentsChanged: vi.fn(),
}));

let app: FastifyInstance;

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
  vi.clearAllMocks();
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
      expiresAt: null,
    });
    upsertFragment({
      id: 'b1',
      target: 'broadcast',
      content: 'c',
      phase: 'footer',
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

describe('PUT /api/fragments/:id', () => {
  it('creates a coordinator-scoped reserved fragment and nudges beacons', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/fragments/swarm-identity',
      payload: {
        target: 'broadcast',
        content: 'We are the test swarm.',
        phase: 'header',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.fragment).toMatchObject({
      id: 'swarm-identity',
      target: 'broadcast',
      scope: 'coordinator',
      expiresAt: null,
    });
    expect(notifyFragmentsChanged).toHaveBeenCalledTimes(1);
  });

  it('preserves createdAt across updates', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/fragments/swarm-identity',
      payload: { target: 'broadcast', content: 'v1' },
    });
    const [first] = listFragments({ target: 'broadcast' });

    await app.inject({
      method: 'PUT',
      url: '/api/fragments/swarm-identity',
      payload: { target: 'broadcast', content: 'v2' },
    });
    const [second] = listFragments({ target: 'broadcast' });

    expect(second.content).toBe('v2');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it('rejects a reserved id targeting an agent with 400', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/fragments/swarm-identity',
      payload: { target: 'agent-1', content: 'c' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('validation');
    expect(notifyFragmentsChanged).not.toHaveBeenCalled();
  });

  it('accepts a reserved broadcast even at the broadcast cap', async () => {
    for (let i = 0; i < 5; i++) {
      upsertFragment({
        id: `bc-${i}`,
        target: 'broadcast',
        content: 'c',
        phase: 'header',
        expiresAt: null,
      });
    }
    const res = await app.inject({
      method: 'PUT',
      url: '/api/fragments/swarm-identity',
      payload: { target: 'broadcast', content: 'c' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects invalid content and oversized payloads', async () => {
    const noContent = await app.inject({
      method: 'PUT',
      url: '/api/fragments/swarm-identity',
      payload: { target: 'broadcast', content: '' },
    });
    expect(noContent.statusCode).toBe(400);
    expect(JSON.parse(noContent.body).code).toBe('validation');

    const oversize = await app.inject({
      method: 'PUT',
      url: '/api/fragments/swarm-identity',
      payload: {
        target: 'broadcast',
        content: 'x'.repeat(16 * 1024 + 1),
      },
    });
    expect(oversize.statusCode).toBe(400);
    expect(JSON.parse(oversize.body).code).toBe('limit');
  });
});

describe('DELETE /api/fragments/:id', () => {
  it('deletes a reserved broadcast fragment and nudges beacons', async () => {
    upsertFragment({
      id: 'swarm-identity',
      target: 'broadcast',
      content: 'c',
      phase: 'header',
      expiresAt: null,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/fragments/swarm-identity?target=broadcast',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(notifyFragmentsChanged).toHaveBeenCalledTimes(1);
    expect(listFragments()).toHaveLength(0);
  });

  it('is 400 when ambiguous without ?target', async () => {
    upsertFragment({
      id: 'amb',
      target: 'agent-1',
      content: 'c',
      phase: 'header',
      expiresAt: null,
    });
    upsertFragment({
      id: 'amb',
      target: 'broadcast',
      content: 'c',
      phase: 'header',
      expiresAt: null,
    });

    const noTarget = await app.inject({
      method: 'DELETE',
      url: '/api/fragments/amb',
    });
    expect(noTarget.statusCode).toBe(400);
    expect(notifyFragmentsChanged).not.toHaveBeenCalled();

    const withTarget = await app.inject({
      method: 'DELETE',
      url: '/api/fragments/amb?target=agent-1',
    });
    expect(withTarget.statusCode).toBe(200);
    expect(listFragments()).toHaveLength(1);
    expect(listFragments()[0].target).toBe('broadcast');
  });

  it('is 404 for unknown ids', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/fragments/missing?target=broadcast',
    });
    expect(res.statusCode).toBe(404);
    expect(notifyFragmentsChanged).not.toHaveBeenCalled();
  });
});
