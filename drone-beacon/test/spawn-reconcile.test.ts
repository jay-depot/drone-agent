import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnRecord } from '../src/types.js';

const { listProcessesMock } = vi.hoisted(() => ({
  listProcessesMock: vi.fn(),
}));

// Keep the pure helpers real; only the OS enumeration is stubbed.
vi.mock('drone-swarm-common', async importOriginal => {
  const actual = await importOriginal<typeof import('drone-swarm-common')>();
  return { ...actual, listProcesses: listProcessesMock };
});

vi.mock('../src/db/index.js', () => ({
  listSpawns: vi.fn(() => []),
  getAgent: vi.fn(() => undefined),
  updateSpawnStatus: vi.fn(),
  unregisterAgent: vi.fn(),
}));

vi.mock('../src/ws-server.js', () => ({
  getConnectedAgents: vi.fn(() => []),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db/index.js');
const wsServer = await import('../src/ws-server.js');
const {
  isSpawnReachable,
  reconcileSpawnRows,
  getSpawnLiveness,
  HEARTBEAT_GRACE_MS,
} = await import('../src/spawn-reconcile.js');

function spawn(overrides: Partial<SpawnRecord> = {}): SpawnRecord {
  return {
    id: 'spawn-1',
    agentId: 'agent-1',
    personaId: null,
    task: null,
    configJson: null,
    status: 'running',
    error: null,
    createdAt: 0,
    startedAt: 0,
    terminatedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function psLine(spawnId: string, pid = 100): string {
  return `  ${pid} drone-agent --spawn-id ${spawnId}`;
}

describe('isSpawnReachable', () => {
  const now = 1_000_000;

  it('is reachable when the agent socket is connected', () => {
    expect(isSpawnReachable('agent-1', null, new Set(['agent-1']), now)).toBe(
      true
    );
  });

  it('is reachable on a fresh heartbeat', () => {
    expect(isSpawnReachable('agent-1', now - 1000, new Set(), now)).toBe(true);
  });

  it('is not reachable when the heartbeat is stale and the socket is down', () => {
    expect(
      isSpawnReachable('agent-1', now - HEARTBEAT_GRACE_MS - 1, new Set(), now)
    ).toBe(false);
  });
});

describe('reconcileSpawnRows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(wsServer.getConnectedAgents).mockReturnValue([]);
    vi.mocked(db.listSpawns).mockReturnValue([]);
    vi.mocked(db.getAgent).mockReturnValue(undefined);
    listProcessesMock.mockResolvedValue([]);
  });

  it('downgrades a running row with no socket, no heartbeat, and no pid', async () => {
    vi.mocked(db.listSpawns).mockReturnValue([spawn()]);
    listProcessesMock.mockResolvedValue([
      { pid: 999, argv: ['some', 'other', 'process'] },
    ]);

    const n = await reconcileSpawnRows();

    expect(n).toBe(1);
    expect(db.updateSpawnStatus).toHaveBeenCalledWith(
      'spawn-1',
      'terminated',
      null,
      'process lost across beacon restart'
    );
    expect(db.unregisterAgent).toHaveBeenCalledWith('agent-1');
  });

  it('keeps a row whose pid is still visible', async () => {
    vi.mocked(db.listSpawns).mockReturnValue([spawn()]);
    listProcessesMock.mockResolvedValue([
      { pid: 100, argv: parseArgv(psLine('spawn-1')) },
    ]);

    const n = await reconcileSpawnRows();

    expect(n).toBe(0);
    expect(db.updateSpawnStatus).not.toHaveBeenCalled();
  });

  it('keeps a row whose agent is still connected', async () => {
    vi.mocked(db.listSpawns).mockReturnValue([spawn()]);
    vi.mocked(wsServer.getConnectedAgents).mockReturnValue(['agent-1']);

    const n = await reconcileSpawnRows();

    expect(n).toBe(0);
    expect(db.updateSpawnStatus).not.toHaveBeenCalled();
  });

  it('keeps a row with a fresh heartbeat', async () => {
    vi.mocked(db.listSpawns).mockReturnValue([spawn()]);
    vi.mocked(db.getAgent).mockReturnValue({
      id: 'agent-1',
      personaId: null,
      status: 'connected',
      connectedAt: 0,
      lastActivity: Date.now(),
    });

    const n = await reconcileSpawnRows();

    expect(n).toBe(0);
  });

  it('never downgrades when enumeration is unavailable', async () => {
    vi.mocked(db.listSpawns).mockReturnValue([spawn()]);
    listProcessesMock.mockResolvedValue(null);

    const n = await reconcileSpawnRows();

    expect(n).toBe(0);
    expect(db.updateSpawnStatus).not.toHaveBeenCalled();
  });

  it('ignores rows that are not running/spawning', async () => {
    vi.mocked(db.listSpawns).mockReturnValue([spawn({ status: 'terminated' })]);

    const n = await reconcileSpawnRows();

    expect(n).toBe(0);
  });
});

describe('getSpawnLiveness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(wsServer.getConnectedAgents).mockReturnValue([]);
    vi.mocked(db.getAgent).mockReturnValue(undefined);
    listProcessesMock.mockResolvedValue([]);
  });

  it('reports a wedge as exists but not reachable', async () => {
    listProcessesMock.mockResolvedValue([
      { pid: 100, argv: parseArgv(psLine('spawn-1')) },
    ]);

    const map = await getSpawnLiveness([spawn()]);
    const liveness = map.get('spawn-1')!;

    expect(liveness.exists).toBe(true);
    expect(liveness.reachable).toBe(false);
    expect(liveness.live).toBe(true);
  });

  it('reports reachable but not exists for a reconnected agent', async () => {
    vi.mocked(wsServer.getConnectedAgents).mockReturnValue(['agent-1']);

    const map = await getSpawnLiveness([spawn()]);
    const liveness = map.get('spawn-1')!;

    expect(liveness.exists).toBe(false);
    expect(liveness.reachable).toBe(true);
    expect(liveness.live).toBe(true);
  });
});

function parseArgv(line: string): string[] {
  return line.trim().split(/\s+/).slice(1);
}
