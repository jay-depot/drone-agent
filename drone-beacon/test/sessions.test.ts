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

describe('GET /sessions (beacon proxy)', () => {
  it('returns 503 when no coordinator client is configured', async () => {
    setCoordinatorClient(undefined);
    const res = await app.inject({ method: 'GET', url: '/sessions?limit=10' });
    expect(res.statusCode).toBe(503);
  });

  it('forwards to the coordinator and passes through the response', async () => {
    const getSessions = vi.fn().mockResolvedValue({
      sessions: [{ id: 's1', personaId: null, status: 'ended' }],
      count: 1,
    });
    setCoordinatorClient(
      makeFakeClient({ getSessions } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'GET',
      url: '/sessions?limit=5&status=ended',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.sessions[0].id).toBe('s1');
    expect(body.count).toBe(1);
    // Query params forwarded.
    expect(getSessions).toHaveBeenCalledWith({
      limit: '5',
      status: 'ended',
    });
  });

  it('forwards the exclude query param to the coordinator', async () => {
    const getSessions = vi.fn().mockResolvedValue({
      sessions: [{ id: 's1', personaId: null, status: 'ended' }],
      count: 1,
    });
    setCoordinatorClient(
      makeFakeClient({ getSessions } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'GET',
      url: '/sessions?exclude=archived&limit=10',
    });
    expect(res.statusCode).toBe(200);
    expect(getSessions).toHaveBeenCalledWith({
      exclude: 'archived',
      limit: '10',
    });
  });
});

describe('GET /sessions/:id/transcript (beacon proxy)', () => {
  it('returns 503 when no coordinator client is configured', async () => {
    setCoordinatorClient(undefined);
    const res = await app.inject({
      method: 'GET',
      url: '/sessions/ss1/transcript',
    });
    expect(res.statusCode).toBe(503);
  });

  it('forwards the transcript from the coordinator', async () => {
    const getSessionTranscript = vi.fn().mockResolvedValue({
      session: { id: 'ss1', personaId: 'coder', status: 'ended' },
      transcript: '# Session ss1\n\n--- Turn 1 ---\n[user] hello',
    });
    setCoordinatorClient(
      makeFakeClient({
        getSessionTranscript,
      } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'GET',
      url: '/sessions/ss1/transcript',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.session.id).toBe('ss1');
    expect(body.transcript).toContain('[user] hello');
    expect(getSessionTranscript).toHaveBeenCalledWith('ss1');
  });

  it('returns 503 when the coordinator has no transcript', async () => {
    setCoordinatorClient(
      makeFakeClient({
        getSessionTranscript: vi.fn().mockResolvedValue(null),
      } as unknown as CoordinatorClient)
    );
    const res = await app.inject({
      method: 'GET',
      url: '/sessions/ss1/transcript',
    });
    expect(res.statusCode).toBe(503);
  });
});
