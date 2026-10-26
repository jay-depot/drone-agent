import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupAllSpawns,
  initSpawner,
  spawnAgent,
  terminateAgent,
  type SpawnDb,
} from '../src/spawner.js';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

function createMockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    exitCode: number | null;
    signalCode: string | null;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

describe('spawner workingDir guard', () => {
  let db: SpawnDb;

  beforeEach(() => {
    spawnMock.mockReset();
    db = {
      createSpawn: vi.fn(() => ({ id: 'spawn-1', status: 'spawning' })),
      updateSpawnStatus: vi.fn(),
      getSpawn: vi.fn(() => undefined),
      unregisterAgent: vi.fn(),
    };
  });

  afterEach(async () => {
    const { cleanupAllSpawns } = await import('../src/spawner.js');
    cleanupAllSpawns();
  });

  it('rejects oversized workingDir before spawning', async () => {
    const { initSpawner, spawnAgent } = await import('../src/spawner.js');
    initSpawner(
      {
        agentPath: 'drone-agent',
        timeoutMs: 60_000,
        maxConcurrentSpawns: 2,
        beaconHost: '127.0.0.1',
        beaconPort: 4000,
      },
      db
    );

    await expect(
      spawnAgent('spawn-1', 'agent-1', null, null, {
        workingDir: 'x'.repeat(4097),
      })
    ).rejects.toThrow('Working directory exceeds maximum length');

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('accepts workingDir at max length and passes it to spawn', async () => {
    const { initSpawner, spawnAgent } = await import('../src/spawner.js');
    initSpawner(
      {
        agentPath: 'drone-agent',
        timeoutMs: 60_000,
        maxConcurrentSpawns: 2,
        beaconHost: '127.0.0.1',
        beaconPort: 4000,
      },
      db
    );
    spawnMock.mockReturnValue(createMockChildProcess());

    const workingDir = 'x'.repeat(4096);
    await spawnAgent('spawn-1', 'agent-1', null, null, { workingDir });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string },
    ];
    expect(cmd).toBe('drone-agent');
    expect(args).toContain('--working-dir');
    expect(args).toContain(workingDir);
    expect(options.cwd).toBe(workingDir);
  });

  it('uses process cwd when workingDir override is not provided', async () => {
    const { initSpawner, spawnAgent } = await import('../src/spawner.js');
    initSpawner(
      {
        agentPath: 'drone-agent',
        timeoutMs: 60_000,
        maxConcurrentSpawns: 2,
        beaconHost: '127.0.0.1',
        beaconPort: 4000,
      },
      db
    );
    spawnMock.mockReturnValue(createMockChildProcess());

    await spawnAgent('spawn-1', 'agent-1', null, null, {});

    const [, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string },
    ];
    expect(args).not.toContain('--working-dir');
    expect(options.cwd).toBe(process.cwd());
  });

  it('emits --spawn-id early in the argv for pid lookup', async () => {
    const { initSpawner, spawnAgent } = await import('../src/spawner.js');
    initSpawner(
      {
        agentPath: 'drone-agent',
        timeoutMs: 60_000,
        maxConcurrentSpawns: 2,
        beaconHost: '127.0.0.1',
        beaconPort: 4000,
      },
      db
    );
    spawnMock.mockReturnValue(createMockChildProcess());

    await spawnAgent('spawn-xyz', 'agent-1', null, null, {});

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    // Front-loaded so `ps -o command=` truncation cannot defeat the match.
    expect(args.slice(0, 4)).toEqual([
      '--swarm',
      '--spawn-id',
      'spawn-xyz',
      '--session-id',
    ]);
  });

  it('persists agent_id at spawn time for terminate lookup', async () => {
    const { initSpawner, spawnAgent } = await import('../src/spawner.js');
    initSpawner(
      {
        agentPath: 'drone-agent',
        timeoutMs: 60_000,
        maxConcurrentSpawns: 2,
        beaconHost: '127.0.0.1',
        beaconPort: 4000,
      },
      db
    );
    spawnMock.mockReturnValue(createMockChildProcess());

    await spawnAgent('spawn-1', 'agent-xyz', null, null, {});

    expect(db.createSpawn).toHaveBeenCalledWith(
      'spawn-1',
      null,
      null,
      {},
      'agent-xyz'
    );
  });

  it('unregisters the agent session when the spawned process exits', async () => {
    const { initSpawner, spawnAgent } = await import('../src/spawner.js');
    initSpawner(
      {
        agentPath: 'drone-agent',
        timeoutMs: 60_000,
        maxConcurrentSpawns: 2,
        beaconHost: '127.0.0.1',
        beaconPort: 4000,
      },
      db
    );
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    await spawnAgent('spawn-1', 'agent-1', null, null, {});

    child.emit('exit', 1, null);

    expect(db.unregisterAgent).toHaveBeenCalledWith('agent-1');
  });

  it('unregisters the agent session when the spawned process errors', async () => {
    const { initSpawner, spawnAgent } = await import('../src/spawner.js');
    initSpawner(
      {
        agentPath: 'drone-agent',
        timeoutMs: 60_000,
        maxConcurrentSpawns: 2,
        beaconHost: '127.0.0.1',
        beaconPort: 4000,
      },
      db
    );
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);

    await spawnAgent('spawn-1', 'agent-2', null, null, {});

    child.emit('error', new Error('spawn ENOENT'));

    expect(db.unregisterAgent).toHaveBeenCalledWith('agent-2');
  });

  it('appends --extension-hint when set', async () => {
    const { initSpawner, spawnAgent } = await import('../src/spawner.js');
    initSpawner(
      {
        agentPath: 'drone-agent',
        timeoutMs: 60_000,
        maxConcurrentSpawns: 2,
        beaconHost: '127.0.0.1',
        beaconPort: 4000,
      },
      db
    );
    spawnMock.mockReturnValue(createMockChildProcess());

    await spawnAgent('spawn-1', 'agent-1', null, null, {
      extensionHint: 'gateway-42',
    });

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const idx = args.indexOf('--extension-hint');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('gateway-42');
  });

  it('omits --extension-hint when unset', async () => {
    const { initSpawner, spawnAgent } = await import('../src/spawner.js');
    initSpawner(
      {
        agentPath: 'drone-agent',
        timeoutMs: 60_000,
        maxConcurrentSpawns: 2,
        beaconHost: '127.0.0.1',
        beaconPort: 4000,
      },
      db
    );
    spawnMock.mockReturnValue(createMockChildProcess());

    await spawnAgent('spawn-1', 'agent-1', null, null, {});

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--extension-hint');
  });
});

describe('terminateAgent SIGKILL escalation', () => {
  let db: SpawnDb;

  beforeEach(() => {
    spawnMock.mockReset();
    db = {
      createSpawn: vi.fn(() => ({ id: 'spawn-1', status: 'spawning' })),
      updateSpawnStatus: vi.fn(),
      getSpawn: vi.fn(() => undefined),
      unregisterAgent: vi.fn(),
    };
    initSpawner(
      {
        agentPath: 'drone-agent',
        timeoutMs: 60_000,
        maxConcurrentSpawns: 2,
        beaconHost: '127.0.0.1',
        beaconPort: 4000,
      },
      db
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupAllSpawns();
  });

  async function spawnChild() {
    const child = createMockChildProcess();
    spawnMock.mockReturnValue(child);
    await spawnAgent('spawn-1', 'agent-1', null, null, {});
    return child;
  }

  it('SIGKILLs a SIGTERM-ignoring child after the grace period', async () => {
    vi.useFakeTimers();
    const child = await spawnChild();

    expect(terminateAgent('spawn-1')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(5_000 - 1);
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
  });

  it('does not SIGKILL and clears the timer when the child exits during grace', async () => {
    vi.useFakeTimers();
    const child = await spawnChild();

    terminateAgent('spawn-1');
    await vi.advanceTimersByTimeAsync(3_000);
    child.emit('exit', 0, null);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('skips signalling and arming a timer for an already-exited child', async () => {
    vi.useFakeTimers();
    const child = await spawnChild();
    child.exitCode = 0;

    expect(terminateAgent('spawn-1')).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('force kills immediately without a grace timer', async () => {
    vi.useFakeTimers();
    const child = await spawnChild();

    expect(terminateAgent('spawn-1', true)).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('returns false for an unknown spawn id', () => {
    expect(terminateAgent('nope')).toBe(false);
  });

  it('unrefs the escalation timer so it cannot hold the process open', async () => {
    const child = await spawnChild();
    const unref = vi.fn();
    const originalSetTimeout = globalThis.setTimeout;
    let armedTimer: ReturnType<typeof setTimeout> | undefined;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, ms, ...args) => {
        const timer = originalSetTimeout(callback, ms, ...args);
        armedTimer = timer;
        Object.defineProperty(timer, 'unref', {
          value: unref,
          configurable: true,
        });
        return timer;
      });

    terminateAgent('spawn-1');

    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(unref).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    if (armedTimer) clearTimeout(armedTimer);
    setTimeoutSpy.mockRestore();
  });
});
