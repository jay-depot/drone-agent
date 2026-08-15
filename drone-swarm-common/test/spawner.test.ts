import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnDb } from '../src/spawner.js';

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
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.killed = false;
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
      { cwd: string }
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
      { cwd: string }
    ];
    expect(args).not.toContain('--working-dir');
    expect(options.cwd).toBe(process.cwd());
  });
});
