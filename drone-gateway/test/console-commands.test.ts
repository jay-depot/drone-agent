import { describe, expect, it, vi } from 'vitest';
import { createConsoleRegistry } from '../src/console/commands.js';
import type { SwarmApi } from '../src/console/swarm-api.js';
import type { ConsoleRunInput } from '../src/console/types.js';

function mockApi(overrides: Partial<SwarmApi> = {}): SwarmApi {
  return {
    listBeacons: vi.fn(async () => []),
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
      deliveredCount: 2,
      totalBeacons: 3,
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

function input(
  api: SwarmApi,
  positionals: string[] = [],
  flags: Record<string, string | boolean> = {}
): ConsoleRunInput {
  return { positionals, flags, json: false, api };
}

function run(
  name: string,
  api: SwarmApi,
  positionals: string[] = [],
  flags: Record<string, string | boolean> = {}
): Promise<string> {
  const command = createConsoleRegistry().get(name);
  if (!command) throw new Error(`missing command ${name}`);
  return command.run(input(api, positionals, flags));
}

describe('createConsoleRegistry', () => {
  it('registers the full v1 command set', () => {
    const names = createConsoleRegistry()
      .list()
      .map(c => c.name);
    expect(names).toEqual([
      'swarm.agent.inject',
      'swarm.agent.persona',
      'swarm.agent.status',
      'swarm.agent.terminate',
      'swarm.beacon.list',
      'swarm.beacon.spawn',
      'swarm.beacon.status',
      'swarm.broadcast',
      'swarm.help',
      'swarm.persona.create',
      'swarm.persona.delete',
      'swarm.persona.list',
      'swarm.persona.update',
      'swarm.session.get',
      'swarm.session.list',
      'swarm.skill.create',
      'swarm.skill.delete',
      'swarm.skill.list',
      'swarm.skill.update',
    ]);
  });

  it('does not register the deferred commands', () => {
    const names = createConsoleRegistry()
      .list()
      .map(c => c.name);
    for (const deferred of [
      'swarm.agent.focus',
      'swarm.agent.interrupt',
      'swarm.beacon.policy',
      'swarm.session.search',
      'swarm.session.delete',
    ]) {
      expect(names).not.toContain(deferred);
    }
  });
});

describe('swarm.help', () => {
  it('lists command usages without calling the API', async () => {
    const api = mockApi();
    const out = await run('swarm.help', api);
    expect(out).toContain('swarm.beacon.list');
    expect(out).toContain('swarm.agent.terminate <agentId>');
    expect(api.listBeacons).not.toHaveBeenCalled();
  });
});

describe('swarm.broadcast', () => {
  it('broadcasts the joined message with the default channel', async () => {
    const api = mockApi();
    const out = await run('swarm.broadcast', api, ['hello', 'world']);
    expect(api.broadcast).toHaveBeenCalledWith({
      fromAgentId: 'gateway',
      channel: 'swarm-console',
      body: 'hello world',
    });
    expect(out).toBe('Broadcast delivered to 2 of 3 beacon(s).');
  });

  it('honors --channel', async () => {
    const api = mockApi();
    await run('swarm.broadcast', api, ['hi'], { channel: 'ops' });
    expect(api.broadcast).toHaveBeenCalledWith({
      fromAgentId: 'gateway',
      channel: 'ops',
      body: 'hi',
    });
  });

  it('returns usage when no message is given', async () => {
    const api = mockApi();
    const out = await run('swarm.broadcast', api);
    expect(out).toContain('Usage: swarm.broadcast');
    expect(api.broadcast).not.toHaveBeenCalled();
  });
});

describe('swarm.persona commands', () => {
  it('list formats personas', async () => {
    const api = mockApi({
      listPersonas: vi.fn(async () => [
        { id: 'p1', name: 'One', description: 'first' },
      ]),
    });
    const out = await run('swarm.persona.list', api);
    expect(out).toBe('p1 — One: first');
  });

  it('list renders (none) for empty', async () => {
    expect(await run('swarm.persona.list', mockApi())).toBe('(none)');
  });

  it('create defaults systemPrompt to the description', async () => {
    const api = mockApi();
    const out = await run('swarm.persona.create', api, ['p1', 'a description']);
    expect(api.createPersona).toHaveBeenCalledWith({
      id: 'p1',
      name: 'p1',
      description: 'a description',
      systemPrompt: 'a description',
    });
    expect(out).toBe('Created persona "p1".');
  });

  it('create uses the provided systemPrompt', async () => {
    const api = mockApi();
    await run('swarm.persona.create', api, ['p1', 'desc', 'prompt']);
    expect(api.createPersona).toHaveBeenCalledWith({
      id: 'p1',
      name: 'p1',
      description: 'desc',
      systemPrompt: 'prompt',
    });
  });

  it('create returns usage when args are missing', async () => {
    const api = mockApi();
    expect(await run('swarm.persona.create', api, ['p1'])).toContain(
      'Usage: swarm.persona.create'
    );
    expect(api.createPersona).not.toHaveBeenCalled();
  });

  it('update sends systemPrompt when provided', async () => {
    const api = mockApi();
    await run('swarm.persona.update', api, ['p1', 'new prompt']);
    expect(api.updatePersona).toHaveBeenCalledWith('p1', {
      systemPrompt: 'new prompt',
    });
  });

  it('update sends an empty patch when no prompt is provided', async () => {
    const api = mockApi();
    await run('swarm.persona.update', api, ['p1']);
    expect(api.updatePersona).toHaveBeenCalledWith('p1', {});
  });

  it('delete calls deletePersona', async () => {
    const api = mockApi();
    const out = await run('swarm.persona.delete', api, ['p1']);
    expect(api.deletePersona).toHaveBeenCalledWith('p1');
    expect(out).toBe('Deleted persona "p1".');
  });
});

describe('swarm.skill commands', () => {
  it('list formats skills', async () => {
    const api = mockApi({
      listSkills: vi.fn(async () => [
        { id: 'k1', name: 'Skill', description: 'does things' },
      ]),
    });
    expect(await run('swarm.skill.list', api)).toBe('k1 — Skill: does things');
  });

  it('create defaults body to the description', async () => {
    const api = mockApi();
    await run('swarm.skill.create', api, ['k1', 'desc']);
    expect(api.createSkill).toHaveBeenCalledWith({
      id: 'k1',
      name: 'k1',
      description: 'desc',
      trigger: 'desc',
      body: 'desc',
    });
  });

  it('create uses the provided body', async () => {
    const api = mockApi();
    await run('swarm.skill.create', api, ['k1', 'desc', 'body']);
    expect(api.createSkill).toHaveBeenCalledWith({
      id: 'k1',
      name: 'k1',
      description: 'desc',
      trigger: 'desc',
      body: 'body',
    });
  });

  it('update sends body when provided', async () => {
    const api = mockApi();
    await run('swarm.skill.update', api, ['k1', 'new body']);
    expect(api.updateSkill).toHaveBeenCalledWith('k1', { body: 'new body' });
  });

  it('update sends an empty patch when no body is provided', async () => {
    const api = mockApi();
    await run('swarm.skill.update', api, ['k1']);
    expect(api.updateSkill).toHaveBeenCalledWith('k1', {});
  });

  it('delete calls deleteSkill', async () => {
    const api = mockApi();
    expect(await run('swarm.skill.delete', api, ['k1'])).toBe(
      'Deleted skill "k1".'
    );
    expect(api.deleteSkill).toHaveBeenCalledWith('k1');
  });
});

describe('swarm.session commands', () => {
  it('list passes through status/limit/offset', async () => {
    const api = mockApi({
      listSessions: vi.fn(async () => ({ sessions: [], count: 0 })),
    });
    await run('swarm.session.list', api, [], {
      status: 'ended',
      limit: '10',
      offset: '5',
    });
    expect(api.listSessions).toHaveBeenCalledWith({
      status: 'ended',
      limit: 10,
      offset: 5,
    });
  });

  it('list formats sessions and appends the truncation tail', async () => {
    const api = mockApi({
      listSessions: vi.fn(async () => ({
        sessions: [{ id: 's1', status: 'running', personaId: 'coder' }],
        count: 3,
      })),
    });
    const out = await run('swarm.session.list', api);
    expect(out).toContain('s1 — running (coder)');
    expect(out).toContain('… 2 more (use --limit/--offset)');
  });

  it('list ignores non-numeric limit', async () => {
    const api = mockApi();
    await run('swarm.session.list', api, [], { limit: 'abc' });
    expect(api.listSessions).toHaveBeenCalledWith({
      status: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('get formats the session', async () => {
    const api = mockApi({
      getSession: vi.fn(async () => ({
        id: 's1',
        status: 'ended',
        personaId: null,
        beaconId: 'b1',
        updatedAt: 0,
      })),
    });
    const out = await run('swarm.session.get', api, ['s1']);
    expect(api.getSession).toHaveBeenCalledWith('s1');
    expect(out).toContain('id: s1');
    expect(out).toContain('persona: (none)');
    expect(out).toContain('beacon: b1');
  });

  it('get returns usage when no id', async () => {
    const api = mockApi();
    expect(await run('swarm.session.get', api)).toContain('Usage:');
    expect(api.getSession).not.toHaveBeenCalled();
  });
});

describe('swarm.beacon commands', () => {
  it('list formats beacons', async () => {
    const api = mockApi({
      listBeacons: vi.fn(async () => [
        { id: 'b1', host: 'h', port: 1, connected: true },
        { id: 'b2', host: 'h', port: 2, connected: false },
      ]),
    });
    expect(await run('swarm.beacon.list', api)).toBe(
      'b1 — connected @ h:1\nb2 — disconnected @ h:2'
    );
  });

  it('status summarizes spawns by status', async () => {
    const api = mockApi({
      listBeacons: vi.fn(async () => [
        { id: 'b1', host: 'h', port: 1, connected: true },
      ]),
      listSpawns: vi.fn(async () => [
        { id: 's1', status: 'running' },
        { id: 's2', status: 'running' },
        { id: 's3', status: 'terminated' },
      ]),
    });
    const out = await run('swarm.beacon.status', api, ['b1']);
    expect(out).toContain('b1 — connected @ h:1');
    expect(out).toContain('spawns: running: 2, terminated: 1');
  });

  it('status reports no spawns when empty', async () => {
    const api = mockApi({
      listBeacons: vi.fn(async () => [
        { id: 'b1', host: 'h', port: 1, connected: true },
      ]),
    });
    expect(await run('swarm.beacon.status', api, ['b1'])).toContain(
      'spawns: no spawns'
    );
  });

  it('status throws for an unknown beacon', async () => {
    const api = mockApi();
    await expect(run('swarm.beacon.status', api, ['nope'])).rejects.toThrow(
      'Beacon not found: nope'
    );
    expect(api.listSpawns).not.toHaveBeenCalled();
  });

  it('spawn forwards beaconId, persona, and task', async () => {
    const api = mockApi();
    const out = await run('swarm.beacon.spawn', api, ['b1'], {
      persona: 'coder',
      task: 'fix',
    });
    expect(api.spawnAgent).toHaveBeenCalledWith({
      targetBeaconId: 'b1',
      personaId: 'coder',
      task: 'fix',
    });
    expect(out).toContain('spawnId: spawn-1');
    expect(out).toContain('agentId: agent-1');
  });

  it('spawn omits persona/task when absent', async () => {
    const api = mockApi();
    await run('swarm.beacon.spawn', api, ['b1']);
    expect(api.spawnAgent).toHaveBeenCalledWith({
      targetBeaconId: 'b1',
      personaId: undefined,
      task: undefined,
    });
  });
});

describe('swarm.agent commands', () => {
  it('status fetches the session by agent id', async () => {
    const api = mockApi();
    await run('swarm.agent.status', api, ['agent-1']);
    expect(api.getSession).toHaveBeenCalledWith('agent-1');
  });

  it('inject sends content and steer false by default', async () => {
    const api = mockApi();
    await run('swarm.agent.inject', api, ['agent-1', 'do', 'this']);
    expect(api.sendSessionMessage).toHaveBeenCalledWith(
      'agent-1',
      'do this',
      false
    );
  });

  it('inject sets steer when --steer is present', async () => {
    const api = mockApi();
    await run('swarm.agent.inject', api, ['agent-1', 'stop'], { steer: true });
    expect(api.sendSessionMessage).toHaveBeenCalledWith(
      'agent-1',
      'stop',
      true
    );
  });

  it('inject returns usage without text', async () => {
    const api = mockApi();
    expect(await run('swarm.agent.inject', api, ['agent-1'])).toContain(
      'Usage:'
    );
    expect(api.sendSessionMessage).not.toHaveBeenCalled();
  });

  it('persona sets the persona', async () => {
    const api = mockApi();
    const out = await run('swarm.agent.persona', api, ['agent-1', 'coder']);
    expect(api.setSessionPersona).toHaveBeenCalledWith('agent-1', 'coder');
    expect(out).toBe('Set persona "coder" for session "agent-1".');
  });

  it('persona clears with --clear', async () => {
    const api = mockApi();
    const out = await run('swarm.agent.persona', api, ['agent-1'], {
      clear: true,
    });
    expect(api.setSessionPersona).toHaveBeenCalledWith('agent-1', null);
    expect(out).toBe('Cleared persona for session "agent-1".');
  });

  it('persona returns usage without persona or --clear', async () => {
    const api = mockApi();
    expect(await run('swarm.agent.persona', api, ['agent-1'])).toContain(
      'Usage:'
    );
    expect(api.setSessionPersona).not.toHaveBeenCalled();
  });
});

describe('swarm.agent.terminate', () => {
  it('resolves the single matching spawn and terminates it', async () => {
    const api = mockApi({
      listBeacons: vi.fn(async () => [{ id: 'b1' }, { id: 'b2' }]),
      listSpawns: vi.fn(async (beaconId: string) =>
        beaconId === 'b2'
          ? [{ id: 'spawn-9', agentId: 'agent-9' }]
          : [{ id: 'spawn-1', agentId: 'agent-1' }]
      ),
    });
    const out = await run('swarm.agent.terminate', api, ['agent-9']);
    expect(api.terminateSpawn).toHaveBeenCalledWith('b2', 'spawn-9');
    expect(out).toBe('Terminated agent "agent-9" (beacon b2, spawn spawn-9).');
  });

  it('errors when no spawn matches', async () => {
    const api = mockApi({
      listBeacons: vi.fn(async () => [{ id: 'b1' }]),
      listSpawns: vi.fn(async () => [{ id: 'spawn-1', agentId: 'other' }]),
    });
    await expect(
      run('swarm.agent.terminate', api, ['agent-1'])
    ).rejects.toThrow('No spawn found for agent "agent-1".');
    expect(api.terminateSpawn).not.toHaveBeenCalled();
  });

  it('errors listing candidates when multiple spawns match', async () => {
    const api = mockApi({
      listBeacons: vi.fn(async () => [{ id: 'b1' }, { id: 'b2' }]),
      listSpawns: vi.fn(async () => [{ id: 'spawn-x', agentId: 'agent-1' }]),
    });
    await expect(
      run('swarm.agent.terminate', api, ['agent-1'])
    ).rejects.toThrow(
      'Multiple spawns match agent "agent-1": agent-1 on beacon b1, spawn spawn-x; agent-1 on beacon b2, spawn spawn-x.'
    );
    expect(api.terminateSpawn).not.toHaveBeenCalled();
  });

  it('returns usage without an agentId', async () => {
    const api = mockApi();
    expect(await run('swarm.agent.terminate', api)).toContain('Usage:');
    expect(api.listBeacons).not.toHaveBeenCalled();
  });
});

describe('--json output', () => {
  it('returns the raw payload for a list command', async () => {
    const api = mockApi({
      listBeacons: vi.fn(async () => [{ id: 'b1' }]),
    });
    const command = createConsoleRegistry().get('swarm.beacon.list');
    const out = await command!.run({
      positionals: [],
      flags: { json: true },
      json: true,
      api,
    });
    expect(out).toBe('```json\n[\n  {\n    "id": "b1"\n  }\n]\n```');
  });

  it('returns the raw payload for terminate', async () => {
    const api = mockApi({
      listBeacons: vi.fn(async () => [{ id: 'b1' }]),
      listSpawns: vi.fn(async () => [{ id: 'spawn-1', agentId: 'agent-1' }]),
      terminateSpawn: vi.fn(async () => ({ status: 'terminated' })),
    });
    const command = createConsoleRegistry().get('swarm.agent.terminate');
    const out = await command!.run({
      positionals: ['agent-1'],
      flags: { json: true },
      json: true,
      api,
    });
    expect(out).toContain('"status": "terminated"');
  });
});
