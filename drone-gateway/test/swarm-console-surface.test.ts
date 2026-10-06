import { describe, expect, it, vi } from 'vitest';
import type { SwarmApi } from '../src/console/swarm-api.js';
import { createSwarmConsoleSurface } from '../src/surfaces/swarm-console.js';
import type { SurfaceContext } from '../src/surfaces/types.js';

function mockApi(overrides: Partial<SwarmApi> = {}): SwarmApi {
  return {
    listBeacons: vi.fn(async () => [
      { id: 'b1', host: 'h', port: 1, connected: true },
    ]),
    listSpawns: vi.fn(async () => []),
    terminateSpawn: vi.fn(async () => ({ status: 'terminated' })),
    spawnAgent: vi.fn(async () => ({
      spawnId: 'spawn-1',
      agentId: 'agent-1',
      status: 'spawning',
    })),
    listSessions: vi.fn(async () => ({ sessions: [], count: 0 })),
    getSession: vi.fn(async () => ({ id: 'agent-1', status: 'running' })),
    sendSessionMessage: vi.fn(async () => ({ success: true })),
    setSessionPersona: vi.fn(async () => ({ id: 'agent-1' })),
    broadcast: vi.fn(async () => ({
      success: true,
      deliveredCount: 1,
      totalBeacons: 1,
    })),
    listPersonas: vi.fn(async () => []),
    createPersona: vi.fn(async () => ({ id: 'p1' })),
    updatePersona: vi.fn(async () => ({ id: 'p1' })),
    deletePersona: vi.fn(async () => ({ success: true })),
    listSkills: vi.fn(async () => []),
    createSkill: vi.fn(async () => ({ id: 'k1' })),
    updateSkill: vi.fn(async () => ({ id: 'k1' })),
    deleteSkill: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

function makeSurface(ctx: Partial<SurfaceContext>) {
  const context: SurfaceContext = {
    spawnBackend: {} as never,
    swarm: undefined,
    ...ctx,
  };
  const surface = createSwarmConsoleSurface(
    { type: 'swarm-console' },
    'conv-1',
    context
  );
  return surface;
}

function msg(text: string) {
  return {
    adapterId: 'a',
    conversationId: 'conv-1',
    text,
    conversationKind: 'dm' as const,
  };
}

describe('createSwarmConsoleSurface', () => {
  it('has a per-conversation id and type', () => {
    const surface = makeSurface({ swarm: mockApi() });
    expect(surface.id).toBe('swarm-console-conv-1');
    expect(surface.type).toBe('swarm-console');
  });

  it('composes: non-swarm text is not handled', async () => {
    const api = mockApi();
    const surface = makeSurface({ swarm: api });
    await expect(surface.handleMessage(msg('hello there'))).resolves.toEqual({
      response: null,
      handled: false,
    });
    expect(api.listBeacons).not.toHaveBeenCalled();
  });

  it('composes: a slash command is not handled', async () => {
    const surface = makeSurface({ swarm: mockApi() });
    await expect(surface.handleMessage(msg('/help'))).resolves.toEqual({
      response: null,
      handled: false,
    });
  });

  it('requires the coordinator backend in local mode', async () => {
    const surface = makeSurface({ swarm: undefined });
    const result = await surface.handleMessage(msg('swarm.beacon.list'));
    expect(result.handled).toBe(true);
    expect(result.response).toContain('requires the coordinator spawn backend');
  });

  it('hints at swarm.help for an unknown command', async () => {
    const surface = makeSurface({ swarm: mockApi() });
    const result = await surface.handleMessage(msg('swarm.beacon.frobnicate'));
    expect(result).toEqual({
      response: 'Unknown command "swarm.beacon.frobnicate". Try swarm.help.',
      handled: true,
    });
  });

  it('runs a known command and returns formatted output', async () => {
    const surface = makeSurface({ swarm: mockApi() });
    const result = await surface.handleMessage(msg('swarm.help'));
    expect(result.handled).toBe(true);
    expect(result.response).toContain('swarm.beacon.list');
    expect(result.response).toContain('swarm.agent.terminate <agentId>');
  });

  it('renders a live beacon list', async () => {
    const surface = makeSurface({ swarm: mockApi() });
    const result = await surface.handleMessage(msg('swarm.beacon.list'));
    expect(result.response).toBe('b1 — connected @ h:1');
  });

  it('passes --json through to the command', async () => {
    const surface = makeSurface({ swarm: mockApi() });
    const result = await surface.handleMessage(msg('swarm.beacon.list --json'));
    expect(result.response).toContain('```json');
  });

  it('reports command failures as Error: ...', async () => {
    const api = mockApi({
      listPersonas: vi.fn(async () => {
        throw new Error('coordinator exploded');
      }),
    });
    const surface = makeSurface({ swarm: api });
    const result = await surface.handleMessage(msg('swarm.persona.list'));
    expect(result).toEqual({
      response: 'Error: coordinator exploded',
      handled: true,
    });
  });

  it('trims surrounding whitespace before parsing', async () => {
    const surface = makeSurface({ swarm: mockApi() });
    const result = await surface.handleMessage(msg('   swarm.help   '));
    expect(result.handled).toBe(true);
    expect(result.response).toContain('swarm.beacon.list');
  });
});
