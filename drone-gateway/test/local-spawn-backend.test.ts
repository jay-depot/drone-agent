import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
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

// Import after mocks
const { LocalSpawnBackend } = await import('../src/local-spawn-backend.js');
const { resolveDroneExecutable } = await import('drone-core');

function makeMockProcess(pid: number, stdoutData: string[]): ChildProcess {
  const stdout = Readable.from(stdoutData.map(d => d + '\n'));
  const stdin = new Writable({
    write(_chunk: Buffer, _enc: string, cb: () => void) {
      cb();
    },
  });
  // A readable stderr so the backend's readline drain can attach (it calls
  // input.resume()). Tests push lines via `emitStderrLine`.
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as ChildProcess;
  Object.assign(proc, {
    pid,
    stdin,
    stdout,
    stderr,
    kill: vi.fn(),
    killed: false,
  });
  return proc as ChildProcess;
}

function emitStderrLine(proc: ChildProcess, line: string): void {
  (proc.stderr as Readable).push(line + '\n');
}

describe('LocalSpawnBackend', () => {
  let backend: InstanceType<typeof LocalSpawnBackend>;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new LocalSpawnBackend();
  });

  describe('spawnSession', () => {
    it('spawns a child process with correct args and returns a SpawnSession', async () => {
      const mockProc = makeMockProcess(12345, []);
      mockSpawn.mockReturnValue(mockProc);

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
      const mockProc = makeMockProcess(12345, []);
      mockSpawn.mockReturnValue(mockProc);

      const session1 = await backend.spawnSession('conv-1', 'coder');
      const session2 = await backend.spawnSession('conv-1', 'coder');

      expect(session2).toBe(session1);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(resolveDroneExecutable).toHaveBeenCalledTimes(1);
    });

    it('falls back to default name when constructed without path', async () => {
      const mockProc = makeMockProcess(12345, []);
      mockSpawn.mockReturnValue(mockProc);

      const session1 = await backend.spawnSession('conv-1', 'coder');
      const session2 = await backend.spawnSession('conv-1', 'coder');

      expect(session2).toBe(session1);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(resolveDroneExecutable).toHaveBeenCalledWith({
        commandName: 'drone-agent',
      });
    });

    it('cleans up session on process exit', async () => {
      const mockProc = makeMockProcess(12345, []);
      mockSpawn.mockReturnValue(mockProc);

      const session = await backend.spawnSession('conv-1', 'coder');

      // Emit exit event
      mockProc.emit('exit', 0, null);

      // Now sending a message should throw since session was cleaned up
      await expect(backend.sendMessage(session, 'hi')).rejects.toThrow(
        'No active session for conversation conv-1'
      );
    });

    it('passes cwd and --working-dir when a working dir is supplied', async () => {
      const mockProc = makeMockProcess(12345, []);
      mockSpawn.mockReturnValue(mockProc);

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
      const mockProc = makeMockProcess(12345, []);
      mockSpawn.mockReturnValue(mockProc);

      await backend.spawnSession('conv-1', 'coder');

      const args = mockSpawn.mock.calls[0][1] as string[];
      expect(args).not.toContain('--working-dir');
      const options = mockSpawn.mock.calls[0][2] as Record<string, unknown>;
      expect(options).not.toHaveProperty('cwd');
    });

    it('dedupes concurrent spawns for the same conversation', async () => {
      const mockProc = makeMockProcess(12345, []);
      mockSpawn.mockReturnValue(mockProc);

      const [a, b] = await Promise.all([
        backend.spawnSession('conv-1', 'coder'),
        backend.spawnSession('conv-1', 'coder'),
      ]);

      expect(a).toBe(b);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('cleans up session on process error', async () => {
      const mockProc = makeMockProcess(12345, []);
      mockSpawn.mockReturnValue(mockProc);

      const session = await backend.spawnSession('conv-1', 'coder');

      // Emit error event
      mockProc.emit('error', new Error('process crashed'));

      await expect(backend.sendMessage(session, 'hi')).rejects.toThrow(
        'No active session for conversation conv-1'
      );
    });
  });

  describe('sendMessage', () => {
    it('writes NDJSON to stdin and returns assistantMessage content on turnComplete', async () => {
      const mockProc = makeMockProcess(12345, [
        JSON.stringify({ kind: 'assistantMessage', content: 'Hello!' }),
        JSON.stringify({ kind: 'turnComplete' }),
      ]);
      mockSpawn.mockReturnValue(mockProc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const response = await backend.sendMessage(session, 'Hi there');

      expect(response).toBe('Hello!');
    });

    it('returns last assistantMessage when multiple are sent before turnComplete', async () => {
      const mockProc = makeMockProcess(12345, [
        JSON.stringify({ kind: 'assistantMessage', content: 'First thought' }),
        JSON.stringify({ kind: 'assistantMessage', content: 'Final answer' }),
        JSON.stringify({ kind: 'turnComplete' }),
      ]);
      mockSpawn.mockReturnValue(mockProc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const response = await backend.sendMessage(session, 'Hi');

      expect(response).toBe('Final answer');
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

    it('skips non-assistantMessage events and returns empty string if no turnComplete', async () => {
      const mockProc = makeMockProcess(12345, [
        JSON.stringify({ kind: 'toolCall', tool: 'read_file' }),
        JSON.stringify({ kind: 'toolResult', result: 'ok' }),
        JSON.stringify({ kind: 'reasoning', content: 'thinking...' }),
      ]);
      mockSpawn.mockReturnValue(mockProc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const response = await backend.sendMessage(session, 'Hi');

      // No turnComplete => the child died/closed stdout before replying.
      expect(response).toContain('Error: agent exited before replying');
    });

    it('includes the child stderr tail in the early-exit error', async () => {
      const mockProc = makeMockProcess(12345, []);
      mockSpawn.mockReturnValue(mockProc);

      const session = await backend.spawnSession('conv-1', 'coder');
      emitStderrLine(mockProc, 'persona "ghost" not found');
      emitStderrLine(mockProc, 'enable the "swarm" plugin');
      await new Promise(resolve => setImmediate(resolve));

      const response = await backend.sendMessage(session, 'Hi');

      expect(response).toContain('Error: agent exited before replying');
      expect(response).toContain('persona "ghost" not found');
      expect(response).toContain('enable the "swarm" plugin');
    });

    it('handles error events from agent gracefully', async () => {
      const mockProc = makeMockProcess(12345, [
        JSON.stringify({ kind: 'error', message: 'Something went wrong' }),
        JSON.stringify({ kind: 'assistantMessage', content: 'Recovered' }),
        JSON.stringify({ kind: 'turnComplete' }),
      ]);
      mockSpawn.mockReturnValue(mockProc);

      const session = await backend.spawnSession('conv-1', 'coder');
      const response = await backend.sendMessage(session, 'Hi');

      expect(response).toBe('Recovered');
    });
  });

  describe('terminateSession', () => {
    it('sends SIGTERM to child process and removes session', async () => {
      const mockProc = makeMockProcess(12345, []);
      mockSpawn.mockReturnValue(mockProc);

      const session = await backend.spawnSession('conv-1', 'coder');
      await backend.terminateSession(session);

      expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('warns if no active session (no-op)', async () => {
      const session = {
        conversationId: 'nonexistent',
        personaId: 'coder',
        processId: 'pid-0',
        startedAt: Date.now(),
      };

      // Should not throw
      await expect(backend.terminateSession(session)).resolves.toBeUndefined();
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
