import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';

// Mock drone-core resolveDroneExecutable to avoid PATH resolution
vi.mock('drone-core', () => ({
  resolveDroneExecutable: vi
    .fn()
    .mockResolvedValue('/usr/local/bin/drone-agent'),
}));

// Mock child_process.spawn
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

// Count stdout readers so we can assert one persistent reader per session.
const readlineSpies = vi.hoisted(() => ({ inputs: [] as unknown[] }));
vi.mock('node:readline', async () => {
  const actual =
    await vi.importActual<typeof import('node:readline')>('node:readline');
  return {
    ...actual,
    createInterface: (opts: Parameters<typeof actual.createInterface>[0]) => {
      readlineSpies.inputs.push(opts.input);
      return actual.createInterface(opts);
    },
  };
});

// Import after mocks
const { LocalSpawnBackend } = await import('../src/local-spawn-backend.js');
const { resolveDroneExecutable } = await import('drone-core');

type MockProcess = {
  proc: ChildProcess;
  stdout: PassThrough;
  stderr: Readable;
  writes: string[];
  pushLine: (event: Record<string, unknown>) => void;
  pushStderr: (line: string) => void;
  endStdout: () => void;
};

function makeMockProcess(pid: number): MockProcess {
  const stdout = new PassThrough();
  const stderr = new Readable({ read() {} });
  const writes: string[] = [];
  const stdin = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      writes.push(chunk.toString());
      cb();
    },
  });
  const proc = new EventEmitter() as ChildProcess;
  Object.assign(proc, {
    pid,
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    killed: false,
    exitCode: null,
    signalCode: null,
  });
  return {
    proc,
    stdout,
    stderr,
    writes,
    pushLine: event => stdout.write(JSON.stringify(event) + '\n'),
    pushStderr: line => stderr.push(line + '\n'),
    endStdout: () => stdout.end(),
  };
}

/** Await one macrotask so a pushed line is delivered to the readline reader. */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

describe('LocalSpawnBackend', () => {
  let backend: InstanceType<typeof LocalSpawnBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    readlineSpies.inputs.length = 0;
    backend = new LocalSpawnBackend();
  });

  describe('spawnSession', () => {
    it('spawns a child process with correct args and returns a SpawnSession', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/local/bin/drone-agent',
        ['--output-json', '--persona', 'coder'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
      );
      expect(session.conversationId).toBe('conv-1');
      expect(session.personaId).toBe('coder');
      expect(session.processId).toBe('pid-12345');
      expect(session.startedAt).toBeGreaterThan(0);
    });

    it('returns existing session for same conversationId (idempotent)', async () => {
      vi.mocked(resolveDroneExecutable).mockClear();
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session1 = await backend.spawnSession('conv-1', 'coder');
      const session2 = await backend.spawnSession('conv-1', 'coder');

      expect(session2).toBe(session1);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(resolveDroneExecutable).toHaveBeenCalledTimes(1);
    });

    it('falls back to default name when constructed without path', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      await backend.spawnSession('conv-1', 'coder');

      expect(resolveDroneExecutable).toHaveBeenCalledWith({
        commandName: 'drone-agent',
      });
    });

    it('cleans up session on process exit', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      mock.proc.emit('exit', 0, null);

      await expect(backend.sendMessage(session, 'hi')).rejects.toThrow(
        'No active session for conversation conv-1'
      );
    });

    it('cleans up session on process error', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      mock.proc.emit('error', new Error('process crashed'));

      await expect(backend.sendMessage(session, 'hi')).rejects.toThrow(
        'No active session for conversation conv-1'
      );
    });

    it('passes cwd and --working-dir when a working dir is supplied', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder', {
        workingDir: '/srv/bots/coder',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/local/bin/drone-agent',
        [
          '--output-json',
          '--persona',
          'coder',
          '--working-dir',
          '/srv/bots/coder',
        ],
        expect.objectContaining({ cwd: '/srv/bots/coder' })
      );
      expect(session.workingDir).toBe('/srv/bots/coder');
    });

    it('omits cwd and --working-dir when no working dir is supplied', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      await backend.spawnSession('conv-1', 'coder');

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain('--working-dir');
      const options = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
      expect(options).not.toHaveProperty('cwd');
    });

    it('passes --extension-hint when an extension hint is supplied', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      await backend.spawnSession('conv-1', 'coder', {
        workingDir: '/srv/bots',
        extensionHint: 'drone-gateway:conv-1',
      });

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).toEqual([
        '--output-json',
        '--persona',
        'coder',
        '--working-dir',
        '/srv/bots',
        '--extension-hint',
        'drone-gateway:conv-1',
      ]);
    });

    it('omits --extension-hint when no hint is supplied', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      await backend.spawnSession('conv-1', 'coder');

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain('--extension-hint');
    });

    it('dedupes concurrent spawns for the same conversation', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const [a, b] = await Promise.all([
        backend.spawnSession('conv-1', 'coder'),
        backend.spawnSession('conv-1', 'coder'),
      ]);

      expect(a).toBe(b);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendMessage', () => {
    it('writes NDJSON to stdin and resolves the assistantMessage on turnComplete', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const promise = backend.sendMessage(session, 'Hi there');
      mock.pushLine({ kind: 'assistantMessage', content: 'Hello!' });
      mock.pushLine({ kind: 'turnComplete' });

      expect(await promise).toBe('Hello!');
      expect(mock.writes).toEqual([
        JSON.stringify({ type: 'chat', message: 'Hi there' }) + '\n',
      ]);
    });

    it('returns the last assistantMessage before turnComplete', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const promise = backend.sendMessage(session, 'Hi');
      mock.pushLine({ kind: 'assistantMessage', content: 'First thought' });
      mock.pushLine({ kind: 'assistantMessage', content: 'Final answer' });
      mock.pushLine({ kind: 'turnComplete' });

      expect(await promise).toBe('Final answer');
    });

    it('attaches a systemReminder when one is supplied', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const promise = backend.sendMessage(session, 'Hi', {
        systemReminder: 'ROOM',
      });
      mock.pushLine({ kind: 'turnComplete' });
      await promise;

      expect(mock.writes[0]).toBe(
        JSON.stringify({
          type: 'chat',
          message: 'Hi',
          systemReminder: 'ROOM',
        }) + '\n'
      );
    });

    it('uses one persistent stdout reader for two turns', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const first = backend.sendMessage(session, 'one');
      mock.pushLine({ kind: 'assistantMessage', content: 'first' });
      mock.pushLine({ kind: 'turnComplete' });
      expect(await first).toBe('first');

      const second = backend.sendMessage(session, 'two');
      mock.pushLine({ kind: 'assistantMessage', content: 'second' });
      mock.pushLine({ kind: 'turnComplete' });
      expect(await second).toBe('second');

      const stdoutReaders = readlineSpies.inputs.filter(
        input => input === mock.stdout
      );
      expect(stdoutReaders).toHaveLength(1);
    });

    it('throws if no active session', async () => {
      const session = {
        conversationId: 'nonexistent',
        personaId: 'coder',
        processId: 'pid-0',
        startedAt: Date.now(),
      };

      await expect(backend.sendMessage(session, 'hi')).rejects.toThrow(
        'No active session for conversation nonexistent'
      );
    });

    it('rejects when the child closes stdout before replying', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const promise = backend.sendMessage(session, 'Hi');
      mock.pushLine({ kind: 'toolCall', tool: 'read_file' });
      mock.pushLine({ kind: 'toolResult', result: 'ok' });
      mock.pushLine({ kind: 'reasoning', content: 'thinking...' });
      mock.endStdout();

      await expect(promise).rejects.toThrow('agent exited before replying');
    });

    it('includes the child stderr tail in the early-exit error', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      mock.pushStderr('persona "ghost" not found');
      mock.pushStderr('enable the "swarm" plugin');
      await flush();

      const promise = backend.sendMessage(session, 'Hi');
      mock.endStdout();

      await expect(promise).rejects.toThrow('agent exited before replying');
      await expect(promise).rejects.toThrow('persona "ghost" not found');
      await expect(promise).rejects.toThrow('enable the "swarm" plugin');
    });

    it('logs and continues past an error event', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const promise = backend.sendMessage(session, 'Hi');
      mock.pushLine({ kind: 'error', message: 'Something went wrong' });
      mock.pushLine({ kind: 'assistantMessage', content: 'Recovered' });
      mock.pushLine({ kind: 'turnComplete' });

      expect(await promise).toBe('Recovered');
    });

    it('rejects a second concurrent request while one is in flight', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const first = backend.sendMessage(session, 'a');
      await expect(backend.sendMessage(session, 'b')).rejects.toThrow(
        'already in flight'
      );
      mock.pushLine({ kind: 'turnComplete' });
      await first;
    });
  });

  describe('exportContext', () => {
    it('writes an exportContext request and resolves the context', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const promise = backend.exportContext(session);
      const context = {
        version: 1,
        createdAt: '2026-10-12T00:00:00.000Z',
        session: { turns: [] },
        tools: [],
        pluginData: {},
      };
      mock.pushLine({ kind: 'contextExport', ok: true, context });

      expect(await promise).toEqual(context);
      expect(mock.writes[0]).toBe(
        JSON.stringify({ type: 'exportContext' }) + '\n'
      );
    });

    it('rejects when the agent reports ok:false', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const promise = backend.exportContext(session);
      mock.pushLine({ kind: 'contextExport', ok: false, error: 'nope' });

      await expect(promise).rejects.toThrow('nope');
    });
  });

  describe('importContext', () => {
    it('writes an importContext request carrying the context and resolves', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const context = {
        version: 1,
        createdAt: '2026-10-12T00:00:00.000Z',
        session: { sourceSessionId: 's0', turns: [] },
        tools: [],
        pluginData: {},
      };
      const promise = backend.importContext(session, context);
      mock.pushLine({ kind: 'contextImport', ok: true });

      await expect(promise).resolves.toBeUndefined();
      expect(mock.writes[0]).toBe(
        JSON.stringify({ type: 'importContext', context }) + '\n'
      );
    });

    it('rejects when the agent reports ok:false', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const promise = backend.importContext(session, {
        version: 1,
        createdAt: '2026-10-12T00:00:00.000Z',
        session: { turns: [] },
        tools: [],
        pluginData: {},
      });
      mock.pushLine({ kind: 'contextImport', ok: false, error: 'bad import' });

      await expect(promise).rejects.toThrow('bad import');
    });
  });

  describe('terminateSession', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('sends SIGTERM to the child process and removes the session', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      await backend.terminateSession(session);

      expect(mock.proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('rejects an in-flight request on terminate', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const promise = backend.sendMessage(session, 'Hi');
      await backend.terminateSession(session);

      await expect(promise).rejects.toThrow('agent exited before replying');
    });

    it('warns if no active session (no-op)', async () => {
      const session = {
        conversationId: 'nonexistent',
        personaId: 'coder',
        processId: 'pid-0',
        startedAt: Date.now(),
      };

      await expect(backend.terminateSession(session)).resolves.toBeUndefined();
    });

    it('escalates to SIGKILL when the child ignores SIGTERM past the grace period', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      await backend.terminateSession(session);

      expect(mock.proc.kill).toHaveBeenCalledWith('SIGTERM');

      vi.advanceTimersByTime(5_000);

      expect(mock.proc.kill).toHaveBeenCalledTimes(2);
      expect(mock.proc.kill).toHaveBeenLastCalledWith('SIGKILL');
    });

    it('does not SIGKILL a child that exits during the grace period', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      await backend.terminateSession(session);

      vi.advanceTimersByTime(4_000);
      mock.proc.emit('exit', 0, null);
      vi.advanceTimersByTime(1_000);

      expect(mock.proc.kill).toHaveBeenCalledTimes(1);
      expect(mock.proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mock.proc.kill).not.toHaveBeenCalledWith('SIGKILL');
    });

    it('sends no signals and arms no timer for an already-exited child', async () => {
      const mock = makeMockProcess(12345);
      Object.assign(mock.proc, { exitCode: 0 });
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const setSpy = vi.spyOn(globalThis, 'setTimeout');
      await backend.terminateSession(session);

      expect(mock.proc.kill).not.toHaveBeenCalled();
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('unrefs the grace timer so it cannot keep the process alive', async () => {
      const mock = makeMockProcess(12345);
      mockSpawn.mockReturnValue(mock.proc);

      const session = await backend.spawnSession('conv-1', 'coder');

      const unrefSpy = vi.fn();
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((() => ({
        unref: unrefSpy,
      })) as unknown as typeof globalThis.setTimeout);

      await backend.terminateSession(session);

      expect(unrefSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveDroneExecutable errors', () => {
    it('throws a clear error when the agent binary cannot be resolved', async () => {
      vi.mocked(resolveDroneExecutable).mockRejectedValueOnce(
        new Error('Unable to resolve executable "drone-agent" from PATH.')
      );

      await expect(backend.spawnSession('conv-1', 'coder')).rejects.toThrow(
        /Unable to resolve executable/
      );
    });
  });
});
