import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

vi.mock('drone-core', () => ({
  resolveDroneExecutable: vi
    .fn()
    .mockResolvedValue('/usr/local/bin/drone-agent'),
}));

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

const { spawnOnce, SpawnOnceFailureError, SpawnOnceTimeoutError } =
  await import('../src/inject/spawn-once.js');
const { resolveDroneExecutable } = await import('drone-core');

interface MockProc {
  proc: ChildProcess;
  stdinData: string[];
  ended: { value: boolean };
  kill: ReturnType<typeof vi.fn>;
}

function makeMockProcess(pid: number, stdoutLines: string[]): MockProc {
  const stdout = Readable.from(stdoutLines.map(d => d + '\n'));
  const stdinData: string[] = [];
  const ended = { value: false };
  const stdin = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      stdinData.push(chunk.toString());
      cb();
    },
    final(cb: () => void) {
      ended.value = true;
      cb();
    },
  });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as ChildProcess;
  const kill = vi.fn();
  Object.assign(proc, {
    pid,
    stdin,
    stdout,
    stderr,
    kill,
    killed: false,
  });
  // Emit close once stdout is fully consumed.
  stdout.on('end', () => proc.emit('close', 0, null));
  return { proc, stdinData, ended, kill };
}

describe('spawnOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveDroneExecutable).mockResolvedValue(
      '/usr/local/bin/drone-agent'
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns with --once --output-json and the persona/model flags', async () => {
    const { proc } = makeMockProcess(1, []);
    mockSpawn.mockReturnValue(proc);

    await spawnOnce({
      task: 'say hi',
      personaId: 'coder',
      workingDir: '/srv/x',
      model: 'p/m',
      timeoutMs: 1000,
    });

    expect(resolveDroneExecutable).toHaveBeenCalledWith({
      commandName: 'drone-agent',
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/local/bin/drone-agent',
      [
        '--once',
        '--output-json',
        '--persona',
        'coder',
        '--working-dir',
        '/srv/x',
        '--model',
        'p/m',
      ],
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: '/srv/x',
      })
    );
  });

  it('writes the kickoff line then ends stdin', async () => {
    const mock = makeMockProcess(1, []);
    mockSpawn.mockReturnValue(mock.proc);

    await spawnOnce({ task: 'do it', timeoutMs: 1000 });

    expect(mock.stdinData.join('')).toBe(
      JSON.stringify({ type: 'kickoff', task: 'do it' }) + '\n'
    );
    expect(mock.ended.value).toBe(true);
  });

  it('returns the LAST assistantMessage', async () => {
    const { proc } = makeMockProcess(1, [
      JSON.stringify({ kind: 'assistantMessage', content: 'First' }),
      JSON.stringify({ kind: 'reasoning', content: 'thinking' }),
      JSON.stringify({ kind: 'assistantMessage', content: 'Final' }),
      JSON.stringify({ kind: 'return', result: 'Final' }),
    ]);
    mockSpawn.mockReturnValue(proc);

    await expect(spawnOnce({ task: 'x', timeoutMs: 1000 })).resolves.toBe(
      'Final'
    );
  });

  it('ignores non-JSON lines', async () => {
    const { proc } = makeMockProcess(1, [
      'not json at all',
      JSON.stringify({ kind: 'assistantMessage', content: 'Hi' }),
    ]);
    mockSpawn.mockReturnValue(proc);

    await expect(spawnOnce({ task: 'x', timeoutMs: 1000 })).resolves.toBe('Hi');
  });

  it('throws SpawnOnceFailureError with the agent error on non-zero exit', async () => {
    const proc = new EventEmitter() as ChildProcess;
    const stdout = Readable.from([]);
    Object.assign(proc, {
      pid: 1,
      stdin: new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
      stdout,
      stderr: new Readable({ read() {} }),
      kill: vi.fn(),
      killed: false,
    });
    stdout.on('end', () => proc.emit('close', 1, null));
    mockSpawn.mockReturnValue(proc);

    await expect(
      spawnOnce({ task: 'x', timeoutMs: 1000 })
    ).rejects.toBeInstanceOf(SpawnOnceFailureError);
  });

  it('throws SpawnOnceTimeoutError and escalates SIGTERM → SIGKILL', async () => {
    vi.useFakeTimers();
    const proc = new EventEmitter() as ChildProcess;
    const stdout = new Readable({ read() {} });
    const kill = vi.fn();
    Object.assign(proc, {
      pid: 1,
      stdin: new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
      stdout,
      stderr: new Readable({ read() {} }),
      kill,
      killed: false,
    });
    mockSpawn.mockReturnValue(proc);

    const err = spawnOnce({ task: 'slow', timeoutMs: 1000 }).catch(e => e);

    await vi.advanceTimersByTimeAsync(1000);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kill).toHaveBeenCalledWith('SIGKILL');

    // Let the close event resolve the promise.
    proc.emit('close', null, 'SIGKILL');
    await expect(err).resolves.toBeInstanceOf(SpawnOnceTimeoutError);
  });
});
