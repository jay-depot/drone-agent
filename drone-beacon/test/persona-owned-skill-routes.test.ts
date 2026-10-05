import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';
import { setCoordinatorClient } from '../src/routes/context.js';
import type { CoordinatorClient } from '../src/coordinator-client.js';

vi.mock('../src/ws-server.js', () => ({
  isLocalConnection: vi.fn().mockReturnValue(true),
  isAgentConnected: vi.fn().mockReturnValue(false),
  getConnectedAgents: vi.fn().mockReturnValue([]),
  getConnection: vi.fn().mockReturnValue(undefined),
  sendToAgent: vi.fn(),
  sendToChannel: vi.fn(),
  registerWebSocketServer: vi.fn(),
  startMessageCleanup: vi.fn(),
  pushFragmentToAgent: vi.fn(),
  pushFragmentSyncToAllConnected: vi.fn(),
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

const PERSONA = {
  id: 'alice',
  name: 'Alice',
  description: 'A persona',
  systemPrompt: '# Alice',
};

const SKILL = {
  id: 'deploy',
  name: 'Deploy',
  description: 'Deploy things',
  trigger: 'deploy',
  body: '# Deploy',
};

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
});

afterEach(async () => {
  setCoordinatorClient(undefined);
  await app.close();
  await teardownDb();
});

describe('Beacon persona-owned skill routes', () => {
  it('creates and lists an owned skill under its persona', async () => {
    await app.inject({ method: 'POST', url: '/personas', payload: PERSONA });

    const create = await app.inject({
      method: 'POST',
      url: '/personas/alice/skills',
      payload: SKILL,
    });
    expect(create.statusCode).toBe(201);
    const created = JSON.parse(create.body);
    expect(created.personaId).toBe('alice');
    expect(created.key).toBe('alice/deploy');

    const list = await app.inject({
      method: 'GET',
      url: '/personas/alice/skills',
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body)).toHaveLength(1);
  });

  it('404s owned-skill routes for an unknown persona', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/personas/missing/skills',
      payload: SKILL,
    });
    expect(res.statusCode).toBe(404);
  });

  it('updates and deletes an owned skill by its composite address', async () => {
    await app.inject({ method: 'POST', url: '/personas', payload: PERSONA });
    await app.inject({
      method: 'POST',
      url: '/personas/alice/skills',
      payload: SKILL,
    });

    const update = await app.inject({
      method: 'PUT',
      url: '/personas/alice/skills/deploy',
      payload: { name: 'Renamed' },
    });
    expect(update.statusCode).toBe(200);
    expect(JSON.parse(update.body).name).toBe('Renamed');

    const del = await app.inject({
      method: 'DELETE',
      url: '/personas/alice/skills/deploy',
    });
    expect(del.statusCode).toBe(200);
    const list = await app.inject({
      method: 'GET',
      url: '/personas/alice/skills',
    });
    expect(JSON.parse(list.body)).toHaveLength(0);
  });

  it('does NOT push an owned skill to the coordinator', async () => {
    const pushSkill = vi.fn().mockResolvedValue(undefined);
    setCoordinatorClient(
      makeFakeClient({ pushSkill } as unknown as CoordinatorClient)
    );
    await app.inject({ method: 'POST', url: '/personas', payload: PERSONA });

    await app.inject({
      method: 'POST',
      url: '/personas/alice/skills',
      payload: SKILL,
    });

    expect(pushSkill).not.toHaveBeenCalled();
  });

  it('DOES push a global skill to the coordinator', async () => {
    const pushSkill = vi.fn().mockResolvedValue(undefined);
    setCoordinatorClient(
      makeFakeClient({ pushSkill } as unknown as CoordinatorClient)
    );

    await app.inject({ method: 'POST', url: '/skills', payload: SKILL });

    expect(pushSkill).toHaveBeenCalledTimes(1);
  });

  it('cascades owned-skill deletion when the persona is deleted', async () => {
    await app.inject({ method: 'POST', url: '/personas', payload: PERSONA });
    await app.inject({
      method: 'POST',
      url: '/personas/alice/skills',
      payload: SKILL,
    });

    const del = await app.inject({ method: 'DELETE', url: '/personas/alice' });
    expect(del.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/personas/alice/skills',
    });
    // Persona is gone, so the owned-skill route 404s.
    expect(list.statusCode).toBe(404);
  });

  it('keeps a global skill addressable by its bare id after an owned skill exists', async () => {
    await app.inject({ method: 'POST', url: '/personas', payload: PERSONA });
    await app.inject({ method: 'POST', url: '/skills', payload: SKILL });
    await app.inject({
      method: 'POST',
      url: '/personas/alice/skills',
      payload: { ...SKILL, name: 'Owned Deploy' },
    });

    const global = await app.inject({ method: 'GET', url: '/skills/deploy' });
    expect(global.statusCode).toBe(200);
    expect(JSON.parse(global.body).personaId).toBeNull();
    expect(JSON.parse(global.body).name).toBe('Deploy');
  });
});
