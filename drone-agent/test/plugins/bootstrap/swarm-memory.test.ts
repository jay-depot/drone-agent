import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSwarmMemoryWorkflow } from '../../../src/plugins/bootstrap/swarm-memory.js';
import { validateConfigFile } from 'drone-swarm-common';

type RecordLike = Record<string, unknown>;

function makeElicit(scripted: Record<string, string>) {
  const asked: Array<{ id: string; prompt: string }> = [];
  const ask = async (questions: Array<RecordLike>) => {
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const id = q.id as string;
      asked.push({ id, prompt: q.prompt as string });
      answers[id] =
        scripted[id] ?? (q.defaultValue as string | undefined) ?? '';
    }
    return answers;
  };
  return { ask, asked };
}

function makeRunner(handlers: {
  bashN?: { code: number; stderr?: string }[];
  crontab?: { code: number; stdout: string };
  crontabInstall?: { code: number };
  systemctl?: { code: number };
  docker?: { code: number; stdout?: string };
  smokeHook?: { code: number; stderr?: string };
}) {
  const calls: string[][] = [];
  let bashNIndex = 0;
  let crontabInstalled = false;
  return {
    calls,
    runner: async (cmd: string[]) => {
      calls.push(cmd);
      const joined = cmd.join(' ');
      if (joined.startsWith('bash -n')) {
        const result = handlers.bashN?.[bashNIndex] ?? { code: 0 };
        bashNIndex += 1;
        return { code: result.code, stdout: '', stderr: result.stderr ?? '' };
      }
      if (joined === 'crontab -l') {
        if (crontabInstalled) {
          return { code: 0, stdout: '0 * * * * bash /tmp/homedir/.drone-swarm-memory/bin/catch-up-ingest.sh >> log', stderr: '' };
        }
        return {
          code: handlers.crontab?.code ?? 1,
          stdout: handlers.crontab?.stdout ?? '',
          stderr: '',
        };
      }
      if (joined === 'crontab -') {
        crontabInstalled = true;
        return {
          code: handlers.crontabInstall?.code ?? 0,
          stdout: '',
          stderr: '',
        };
      }
      if (joined.startsWith('systemctl status')) {
        return { code: handlers.systemctl?.code ?? 1, stdout: '', stderr: '' };
      }
      if (joined.startsWith('docker ps')) {
        return {
          code: handlers.docker?.code ?? 1,
          stdout: handlers.docker?.stdout ?? '',
          stderr: '',
        };
      }
      if (joined.includes('session list')) {
        return {
          code: 0,
          stdout: JSON.stringify({ sessions: [{ id: 'sess-1' }], count: 1 }),
          stderr: '',
        };
      }
      if (joined.startsWith('bash') && joined.includes('session-end-ingest')) {
        return {
          code: handlers.smokeHook?.code ?? 0,
          stdout: '',
          stderr: handlers.smokeHook?.stderr ?? '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  };
}

function makeCtx(elicit: { ask: unknown }) {
  return {
    elicit,
    projectDir: '/tmp/unused',
    config: {},
    requestCapability: () => undefined,
    enablePlugin: async () => true,
  };
}

const HAPPY: Record<string, string> = {
  coordinatorUrl: 'http://127.0.0.1:3456',
  configureBeacon: 'no',
  batchLimit: '5',
  cronSchedule: '0 * * * *',
  'write-hook': 'yes',
  'write-catchup': 'yes',
  'write-cron': 'yes',
  'write-config-coordinator': 'yes',
  'restart-coordinator': 'yes',
  smoke: 'no',
};

describe('bootstrap swarm-memory workflow', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'swarm-memory-test-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('elicits before every write and installs scripts, cron, and config', async () => {
    const { runner, calls } = makeRunner({
      crontab: { code: 1, stdout: '' },
      systemctl: { code: 0 },
    });
    const { ask, asked } = makeElicit({ ...HAPPY });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = await workflow.run(
      {},
      makeCtx({ ask }) as never
    );
    const parsed = JSON.parse(result.toolResult as string) as {
      ok: boolean;
      steps: { step: string; status: string }[];
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.steps.find(s => s.step === 'hook-script')?.status).toBe(
      'done'
    );
    expect(parsed.steps.find(s => s.step === 'cron')?.status).toBe('done');
    expect(
      parsed.steps.find(s => s.step === 'config-coordinator')?.status
    ).toBe('done');

    const hookPath = path.join(
      home,
      '.drone-swarm-memory',
      'bin',
      'session-end-ingest.sh'
    );
    const hookScript = await readFile(hookPath, 'utf-8');
    expect(hookScript).toContain('{session_id}');
    expect((await stat(hookPath)).mode & 0o111).not.toBe(0);

    const configPath = path.join(home, '.drone-coordinator', 'config.json');
    const written = JSON.parse(await readFile(configPath, 'utf-8')) as unknown;
    expect(written).toMatchObject({
      sessionEnd: {
        type: 'command',
        command: `${hookPath} {session_id}`,
      },
    });
    expect(validateConfigFile(written)).toEqual([]);

    const ids = asked.map(a => a.id);
    expect(ids).toEqual([
      'coordinatorUrl',
      'configureBeacon',
      'batchLimit',
      'cronSchedule',
      'write-hook',
      'write-catchup',
      'write-cron',
      'write-config-coordinator',
      'restart-coordinator',
      'smoke',
    ]);
    expect(calls.some(c => c.join(' ').startsWith('systemctl restart'))).toBe(
      true
    );
    expect(calls.filter(c => c.join(' ').startsWith('bash -n'))).toHaveLength(
      2
    );
  });

  it('replaces a differing-type sessionEnd trigger wholesale', async () => {
    await mkdir(path.join(home, '.drone-coordinator'), { recursive: true });
    const configPath = path.join(home, '.drone-coordinator', 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        port: 3456,
        sessionEnd: {
          type: 'spawn',
          persona: 'coordinator-wiki-librarian',
        },
      })
    );

    const { runner } = makeRunner({ crontab: { code: 1, stdout: '' } });
    const { ask } = makeElicit({ ...HAPPY });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    await workflow.run({}, makeCtx({ ask }) as never);

    const written = JSON.parse(
      await readFile(configPath, 'utf-8')
    ) as RecordLike;
    const sessionEnd = written.sessionEnd as RecordLike;
    expect(sessionEnd.type).toBe('command');
    expect(sessionEnd.persona).toBeUndefined();
    expect(written.port).toBe(3456);
  });

  it('stops cleanly when the hook script is declined', async () => {
    const { runner } = makeRunner({ crontab: { code: 1, stdout: '' } });
    const { ask, asked } = makeElicit({ ...HAPPY, 'write-hook': 'no' });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = await workflow.run({}, makeCtx({ ask }) as never);
    const parsed = JSON.parse(result.toolResult as string) as {
      ok: boolean;
      outcome: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.outcome).toContain('declined');
    expect(asked.map(a => a.id)).not.toContain('write-config-coordinator');
  });

  it('skips the smoke test entirely when declined', async () => {
    const { runner, calls } = makeRunner({ crontab: { code: 1, stdout: '' } });
    const { ask } = makeElicit({ ...HAPPY, smoke: 'no' });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = await workflow.run({}, makeCtx({ ask }) as never);
    const parsed = JSON.parse(result.toolResult as string) as {
      steps: { step: string; status: string }[];
    };
    expect(
      parsed.steps.find(s => s.step === 'smoke')?.status
    ).toBe('skipped');
    expect(
      calls.filter(c =>
        c.join(' ').includes('session-end-ingest.sh sess')
      )
    ).toHaveLength(0);
  });

  it('surfaces bash -n failures in the report', async () => {
    const { runner } = makeRunner({
      crontab: { code: 1, stdout: '' },
      bashN: [{ code: 2, stderr: 'syntax error near token fi' }],
    });
    const { ask } = makeElicit({ ...HAPPY });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = await workflow.run({}, makeCtx({ ask }) as never);
    const parsed = JSON.parse(result.toolResult as string) as {
      ok: boolean;
      steps: { step: string; status: string; detail?: string }[];
    };
    const failed = parsed.steps.find(s => s.status === 'failed');
    expect(failed?.detail).toContain('syntax error');
    expect(parsed.ok).toBe(false);
  });

  it('falls back to instruct-only restart guidance when launch mode is unknown', async () => {
    const { runner } = makeRunner({
      crontab: { code: 1, stdout: '' },
      systemctl: { code: 1 },
      docker: { code: 1 },
    });
    const { ask } = makeElicit({ ...HAPPY });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = await workflow.run({}, makeCtx({ ask }) as never);
    const parsed = JSON.parse(result.toolResult as string) as {
      pendingRestart: string[];
    };
    expect(parsed.pendingRestart).toHaveLength(1);
    expect(parsed.pendingRestart[0]).toContain('restart it yourself');
  });
});