import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnRecord } from '../src/types.js';

vi.mock('../src/spawner.js', () => ({
  spawnAgent: vi.fn(),
  terminateAgent: vi.fn(),
  findPidBySpawnId: vi.fn(),
}));

vi.mock('../src/ws-server.js', () => ({
  isAgentConnected: vi.fn(),
  sendToAgent: vi.fn(),
}));

vi.mock('../src/spawn-roots.js', () => ({
  getDefaultSpawnRoot: vi.fn(),
  getSpawnRoots: vi.fn(),
  isSpawnRootAllowed: vi.fn(),
}));

vi.mock('../src/db/index.js', () => ({
  getPersona: vi.fn(),
  createSpawn: vi.fn(),
  updateSpawnStatus: vi.fn(),
  getSpawn: vi.fn(),
}));

vi.mock('../src/routes/context.js', () => ({
  getBeaconUrl: vi.fn(() => 'http://localhost:3457'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handleSpawnAgent, handleTerminateSpawn } =
  await import('../src/routes/spawn-handlers.js');
const spawner = await import('../src/spawner.js');
const spawnRoots = await import('../src/spawn-roots.js');
const wsServer = await import('../src/ws-server.js');
const dbModule = await import('../src/db/index.js');

describe('handleSpawnAgent spawnRoots enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spawner.spawnAgent).mockResolvedValue({
      id: 'spawn-1',
      agentId: 'agent-1',
      personaId: null,
      task: null,
      configJson: null,
      status: 'spawning',
      error: null,
      createdAt: 0,
      startedAt: null,
      terminatedAt: null,
      exitCode: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a workingDir outside the whitelist with a 400', async () => {
    vi.mocked(spawnRoots.isSpawnRootAllowed).mockReturnValue(false);
    vi.mocked(spawnRoots.getSpawnRoots).mockReturnValue(['/allowed']);

    const result = await handleSpawnAgent({
      config: { workingDir: '/not-allowed' },
    });

    expect(result.status).toBe(400);
    expect(result.body.error).toContain('not in the spawnRoots whitelist');
    expect(spawner.spawnAgent).not.toHaveBeenCalled();
  });

  it('accepts a workingDir within the whitelist', async () => {
    vi.mocked(spawnRoots.isSpawnRootAllowed).mockReturnValue(true);

    const result = await handleSpawnAgent({
      config: { workingDir: '/allowed' },
    });

    expect(result.status).toBe(202);
    expect(spawner.spawnAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      null,
      null,
      { workingDir: '/allowed' }
    );
  });

  it('defaults to the configured default root when workingDir is omitted', async () => {
    vi.mocked(spawnRoots.getDefaultSpawnRoot).mockReturnValue('/default-root');

    const result = await handleSpawnAgent({});

    expect(result.status).toBe(202);
    expect(spawner.spawnAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      null,
      null,
      { workingDir: '/default-root' }
    );
  });
});

describe('handleTerminateSpawn ladder', () => {
  const fastTiming = { stage1GraceMs: 0, stage2GraceMs: 0, pollIntervalMs: 1 };

  function spawnRecord(agentId: string | null, status: string): SpawnRecord {
    return {
      id: 'spawn-1',
      agentId,
      personaId: null,
      task: null,
      configJson: null,
      status: status as SpawnRecord['status'],
      error: null,
      createdAt: 0,
      startedAt: 0,
      terminatedAt: null,
      exitCode: null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('404s for an unknown spawn', async () => {
    vi.mocked(dbModule.getSpawn).mockReturnValue(undefined);
    const result = await handleTerminateSpawn('missing', fastTiming);
    expect(result.status).toBe(404);
  });

  it('400s when the spawn is not running/spawning', async () => {
    vi.mocked(dbModule.getSpawn).mockReturnValue(
      spawnRecord(null, 'terminated')
    );
    const result = await handleTerminateSpawn('spawn-1', fastTiming);
    expect(result.status).toBe(400);
  });

  it('stage 1: asks a connected agent to shut down and reports graceful exit', async () => {
    vi.mocked(dbModule.getSpawn).mockReturnValue(
      spawnRecord('agent-1', 'running')
    );
    vi.mocked(wsServer.isAgentConnected)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const result = await handleTerminateSpawn('spawn-1', fastTiming);

    expect(wsServer.sendToAgent).toHaveBeenCalledWith('agent-1', {
      type: 'shutdown',
    });
    expect(result.status).toBe(200);
    expect(dbModule.updateSpawnStatus).toHaveBeenCalledWith(
      'spawn-1',
      'terminated'
    );
  });

  it('stage 2: SIGTERMs the pid found by argv lookup', async () => {
    vi.mocked(dbModule.getSpawn).mockReturnValue(spawnRecord(null, 'running'));
    vi.mocked(spawner.findPidBySpawnId).mockResolvedValue({
      status: 'found',
      pid: 4242,
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });

    const result = await handleTerminateSpawn('spawn-1', fastTiming);

    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(result.status).toBe(200);
    killSpy.mockRestore();
  });

  it('stage 3: escalates to SIGKILL when the process survives SIGTERM', async () => {
    vi.mocked(dbModule.getSpawn).mockReturnValue(spawnRecord(null, 'running'));
    vi.mocked(spawner.findPidBySpawnId).mockResolvedValue({
      status: 'found',
      pid: 4242,
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const result = await handleTerminateSpawn('spawn-1', fastTiming);

    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(result.status).toBe(200);
    killSpy.mockRestore();
  });

  it('409s when enumeration is unavailable and the agent is unreachable', async () => {
    vi.mocked(dbModule.getSpawn).mockReturnValue(spawnRecord(null, 'running'));
    vi.mocked(spawner.findPidBySpawnId).mockResolvedValue({
      status: 'unavailable',
    });

    const result = await handleTerminateSpawn('spawn-1', fastTiming);

    expect(result.status).toBe(409);
    expect(dbModule.updateSpawnStatus).not.toHaveBeenCalled();
  });

  it('409s and records a lost process when the pid is absent', async () => {
    vi.mocked(dbModule.getSpawn).mockReturnValue(spawnRecord(null, 'running'));
    vi.mocked(spawner.findPidBySpawnId).mockResolvedValue({ status: 'absent' });

    const result = await handleTerminateSpawn('spawn-1', fastTiming);

    expect(result.status).toBe(409);
    expect(dbModule.updateSpawnStatus).toHaveBeenCalledWith(
      'spawn-1',
      'terminated',
      null,
      'process lost across beacon restart'
    );
  });
});
