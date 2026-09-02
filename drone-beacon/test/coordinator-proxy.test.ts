import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';
import { setCoordinatorClient } from '../src/routes/context.js';
import type { CoordinatorClient } from '../src/coordinator-client.js';

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

function makeFakeClient(
  overrides: Partial<CoordinatorClient> = {}
): CoordinatorClient {
  return {
    getBaseUrl: () => 'http://coordinator:3456',
    getFetch: () => fetch as typeof fetch,
    ...overrides,
  } as unknown as CoordinatorClient;
}

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
});

afterEach(async () => {
  setCoordinatorClient(undefined);
  await app.close();
  await teardownDb();
});

describe('GET /coordinator/beacons (beacon proxy)', () => {
  it('returns 503 when no coordinator client is configured', async () => {
    setCoordinatorClient(undefined);
    const res = await app.inject({
      method: 'GET',
      url: '/coordinator/beacons',
    });
    expect(res.statusCode).toBe(503);
  });

  it('passes through the beacon list from the coordinator', async () => {
    const listBeacons = vi
      .fn()
      .mockResolvedValue([
        { id: 'b1', name: 'Beacon 1', host: 'localhost', port: 3457 },
      ]);
    setCoordinatorClient(
      makeFakeClient({ listBeacons } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'GET',
      url: '/coordinator/beacons',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)[0].id).toBe('b1');
    expect(listBeacons).toHaveBeenCalledWith();
  });
});

describe('GET /coordinator/agents/location (beacon proxy)', () => {
  it('forwards the optional beaconId filter', async () => {
    const listAgentLocations = vi.fn().mockResolvedValue([]);
    setCoordinatorClient(
      makeFakeClient({
        listAgentLocations,
      } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'GET',
      url: '/coordinator/agents/location?beaconId=b1',
    });
    expect(res.statusCode).toBe(200);
    expect(listAgentLocations).toHaveBeenCalledWith('b1');
  });
});

describe('POST /coordinator/spawn (beacon proxy)', () => {
  it('forwards the spawn request and passes through the response', async () => {
    const spawnSpawn = vi.fn().mockResolvedValue({
      spawnId: 's1',
      agentId: 'agent-abc',
      status: 'spawning',
    });
    setCoordinatorClient(
      makeFakeClient({ spawnSpawn } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'POST',
      url: '/coordinator/spawn',
      payload: { targetBeaconId: 'b1', task: 'fix bugs' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.spawnId).toBe('s1');
    expect(spawnSpawn).toHaveBeenCalledWith({
      targetBeaconId: 'b1',
      task: 'fix bugs',
    });
  });

  it('returns 503 when the coordinator is unavailable', async () => {
    setCoordinatorClient(
      makeFakeClient({
        spawnSpawn: vi.fn().mockResolvedValue(null),
      } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'POST',
      url: '/coordinator/spawn',
      payload: { targetBeaconId: 'b1' },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('wiki coordinator-scope proxy (missing /api prefix + no mTLS identity fix)', () => {
  it('proxies a coordinator-scope wiki write to the /api/wiki path via the client fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'sess-page', title: 'Title' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const fakeGetFetch = vi.fn().mockReturnValue(fetchMock);
    setCoordinatorClient(makeFakeClient({ getFetch: fakeGetFetch }));

    const res = await app.inject({
      method: 'PUT',
      url: '/wiki/sess-page',
      payload: {
        title: 'Title',
        content: 'Body',
        scope: 'coordinator',
        tags: [],
        sources: [],
      },
    });

    expect(res.statusCode).toBe(200);
    // The proxied request must hit the coordinator's /api-prefixed wiki route
    // (previously it went to /wiki/... which the SPA fallback answered with
    // index.html 200, then res.json() threw → beacon 500 "Internal Server Error").
    expect(fetchMock).toHaveBeenCalledWith(
      'http://coordinator:3456/api/wiki/sess-page',
      expect.objectContaining({ method: 'PUT' })
    );
    // The client's pre-configured fetch (fingerprint + mTLS identity) must be
    // used, not a fresh createCoordinatorFetch with no credentials.
    expect(fakeGetFetch).toHaveBeenCalledTimes(1);
  });

  it('does not double-prefix a path that already carries /api', async () => {
    const { coordinatorApiPath } = await import('../src/routes/context.js');
    expect(coordinatorApiPath('/api/wiki/sess-page')).toBe(
      '/api/wiki/sess-page'
    );
    expect(coordinatorApiPath('/wiki/sess-page')).toBe('/api/wiki/sess-page');
    expect(coordinatorApiPath('/insights')).toBe('/api/insights');
  });
});

describe('GET /coordinator/spawn/:beaconId/:spawnId (beacon proxy)', () => {
  it('forwards getSpawn', async () => {
    const getSpawn = vi.fn().mockResolvedValue({
      spawnId: 's1',
      status: 'running',
    });
    setCoordinatorClient(
      makeFakeClient({ getSpawn } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'GET',
      url: '/coordinator/spawn/b1/s1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('running');
    expect(getSpawn).toHaveBeenCalledWith('b1', 's1');
  });
});

describe('GET /coordinator/spawn/:beaconId (beacon proxy)', () => {
  it('forwards listSpawns with optional status', async () => {
    const listSpawns = vi.fn().mockResolvedValue([]);
    setCoordinatorClient(
      makeFakeClient({ listSpawns } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'GET',
      url: '/coordinator/spawn/b1?status=running',
    });
    expect(res.statusCode).toBe(200);
    expect(listSpawns).toHaveBeenCalledWith('b1', 'running');
  });
});

describe('DELETE /coordinator/spawn/:beaconId/:spawnId (beacon proxy)', () => {
  it('forwards terminateSpawn', async () => {
    const terminateSpawn = vi.fn().mockResolvedValue({
      success: true,
      message: 'Termination signal sent',
    });
    setCoordinatorClient(
      makeFakeClient({
        terminateSpawn,
      } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'DELETE',
      url: '/coordinator/spawn/b1/s1',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).success).toBe(true);
    expect(terminateSpawn).toHaveBeenCalledWith('b1', 's1');
  });

  it('returns 503 when the coordinator is unavailable', async () => {
    setCoordinatorClient(
      makeFakeClient({
        terminateSpawn: vi.fn().mockResolvedValue(null),
      } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'DELETE',
      url: '/coordinator/spawn/b1/s1',
    });
    expect(res.statusCode).toBe(503);
  });
});
