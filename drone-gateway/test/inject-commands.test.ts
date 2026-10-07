import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const mockInject = vi.fn();

vi.mock('../src/inject/client.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/inject/client.js')>();
  return {
    ...actual,
    ControlApiClient: vi.fn().mockImplementation(function () {
      return {
        inject: mockInject,
        status: vi.fn(),
        listConversations: vi.fn(),
      };
    }),
  };
});

const mockSpawnOnce = vi.fn();

vi.mock('../src/inject/spawn-once.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/inject/spawn-once.js')>();
  return {
    ...actual,
    spawnOnce: mockSpawnOnce,
  };
});

const { runInjectCli } = await import('../src/inject/commands.js');
const { GatewayHttpError } = await import('../src/inject/client.js');

function commonFlags(): string[] {
  return [
    '--adapter',
    'matrix',
    '--conversation',
    '!room:s',
    '--host',
    '127.0.0.1',
    '--port',
    '1',
  ];
}

describe('runInjectCli', () => {
  let out: string;
  let err: string;

  beforeEach(() => {
    vi.clearAllMocks();
    out = '';
    err = '';
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('prints usage on --help and exits 0', async () => {
    await runInjectCli(['--help']);
    expect(out).toContain('run-agent');
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exit 1 on a parse error', async () => {
    await runInjectCli(['bogus-subcommand']);
    expect(err).toContain('Unknown subcommand');
    expect(process.exitCode).toBe(1);
  });

  describe('inject-message', () => {
    it('injects the prefixed literal text', async () => {
      mockInject.mockResolvedValue(undefined);
      await runInjectCli([
        'inject-message',
        ...commonFlags(),
        '--prefix',
        'X ',
        'hello',
      ]);
      expect(mockInject).toHaveBeenCalledWith('matrix', '!room:s', 'X hello');
      expect(process.exitCode).toBeUndefined();
    });

    it('reports JSON when --json is set', async () => {
      mockInject.mockResolvedValue(undefined);
      await runInjectCli(['inject-message', ...commonFlags(), '--json', 'hi']);
      expect(JSON.parse(out)).toMatchObject({
        ok: true,
        injected: true,
        text: 'hi',
      });
    });

    it('sets exit 1 when the gateway rejects the injection', async () => {
      mockInject.mockRejectedValue(new GatewayHttpError(403, 'not a target'));
      await runInjectCli(['inject-message', ...commonFlags(), 'hi']);
      expect(err).toContain('403');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('run-agent', () => {
    it('injects the final chat message', async () => {
      mockSpawnOnce.mockResolvedValue('FINAL ANSWER');
      mockInject.mockResolvedValue(undefined);
      await runInjectCli([
        'run-agent',
        ...commonFlags(),
        '--prefix',
        '> ',
        'do it',
      ]);
      expect(mockSpawnOnce).toHaveBeenCalledWith(
        expect.objectContaining({ task: 'do it' })
      );
      expect(mockInject).toHaveBeenCalledWith(
        'matrix',
        '!room:s',
        '> FINAL ANSWER'
      );
      expect(process.exitCode).toBeUndefined();
    });

    it('passes persona/working-dir/model/timeout to spawnOnce', async () => {
      mockSpawnOnce.mockResolvedValue('ok');
      mockInject.mockResolvedValue(undefined);
      await runInjectCli([
        'run-agent',
        ...commonFlags(),
        '--persona',
        'coder',
        '--working-dir',
        '/srv/x',
        '--model',
        'p/m',
        '--agent-path',
        '/usr/bin/drone-agent',
        '--timeout',
        '30',
        'task',
      ]);
      expect(mockSpawnOnce).toHaveBeenCalledWith({
        task: 'task',
        personaId: 'coder',
        workingDir: '/srv/x',
        model: 'p/m',
        agentPath: '/usr/bin/drone-agent',
        timeoutMs: 30_000,
      });
    });

    it('suppresses injection on the sentinel with --no-response-sentinel (exit 0)', async () => {
      mockSpawnOnce.mockResolvedValue('<<NO_RESPONSE>>');
      await runInjectCli([
        'run-agent',
        ...commonFlags(),
        '--json',
        '--no-response-sentinel',
        'task',
      ]);
      expect(mockInject).not.toHaveBeenCalled();
      expect(err).toContain('declined to respond');
      expect(JSON.parse(out)).toEqual({
        ok: true,
        injected: false,
        suppressed: true,
      });
      expect(process.exitCode).toBeUndefined();
    });

    it('injects the sentinel when the flag is absent', async () => {
      mockSpawnOnce.mockResolvedValue('<<NO_RESPONSE>>');
      mockInject.mockResolvedValue(undefined);
      await runInjectCli(['run-agent', ...commonFlags(), 'task']);
      expect(mockInject).toHaveBeenCalledWith(
        'matrix',
        '!room:s',
        '<<NO_RESPONSE>>'
      );
    });

    it('does not inject an empty final message (exit 0)', async () => {
      mockSpawnOnce.mockResolvedValue('   ');
      await runInjectCli(['run-agent', ...commonFlags(), '--json', 'task']);
      expect(mockInject).not.toHaveBeenCalled();
      expect(JSON.parse(out)).toEqual({
        ok: true,
        injected: false,
        suppressed: false,
      });
      expect(process.exitCode).toBeUndefined();
    });

    it('exits 1 without injecting when the child fails', async () => {
      const { SpawnOnceFailureError } =
        await import('../src/inject/spawn-once.js');
      mockSpawnOnce.mockRejectedValue(new SpawnOnceFailureError('agent died'));
      await runInjectCli(['run-agent', ...commonFlags(), 'task']);
      expect(mockInject).not.toHaveBeenCalled();
      expect(err).toContain('agent died');
      expect(process.exitCode).toBe(1);
    });

    it('exits 1 without injecting when the child times out', async () => {
      const { SpawnOnceTimeoutError } =
        await import('../src/inject/spawn-once.js');
      mockSpawnOnce.mockRejectedValue(new SpawnOnceTimeoutError('too slow'));
      await runInjectCli(['run-agent', ...commonFlags(), 'task']);
      expect(mockInject).not.toHaveBeenCalled();
      expect(err).toContain('too slow');
      expect(process.exitCode).toBe(1);
    });
  });
});
