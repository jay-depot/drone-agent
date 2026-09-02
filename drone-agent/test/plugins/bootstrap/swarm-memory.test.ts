import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
  binaryCheck?: { code: number };
  probe?: { code: number; stderr?: string; stdout?: string };
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
          return {
            code: 0,
            stdout:
              '0 * * * * bash /tmp/homedir/.drone-swarm-memory/bin/catch-up-ingest.sh >> log',
            stderr: '',
          };
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
      if (joined.startsWith('sh -c command -v drone-swarm')) {
        return {
          code: handlers.binaryCheck?.code ?? 0,
          stdout: '',
          stderr: '',
        };
      }
      if (joined.includes('session list --limit 1')) {
        return {
          code: handlers.probe?.code ?? 0,
          stdout:
            handlers.probe?.stdout ??
            JSON.stringify({ sessions: [{ id: 'sess-1' }], count: 1 }),
          stderr: handlers.probe?.stderr ?? '',
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

function makeCtx(
  elicit: { ask: unknown },
  agentScript?: (server: string) => string
) {
  const agentCalls: string[] = [];
  return {
    elicit,
    projectDir: '/tmp/unused',
    config: {},
    requestCapability: () => undefined,
    enablePlugin: async () => true,
    agent: async (prompt: string) => {
      agentCalls.push(prompt);
      const server = prompt.includes('the beacon') ? 'beacon' : 'coordinator';
      return agentScript
        ? agentScript(server)
        : 'launch=systemd restart=systemctl restart drone-coordinator';
    },
    agentCalls,
  };
}

const HAPPY: Record<string, string> = {
  coordinatorUrl: 'http://127.0.0.1:3456',
  webToken: '',
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
    const result = await workflow.run({}, makeCtx({ ask }) as never);
    const parsed = JSON.parse(
      (result as { toolResult?: string }).toolResult ?? ''
    ) as {
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
      'webToken',
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
    expect(
      calls.some(c => c.join(' ').includes('command -v drone-swarm'))
    ).toBe(true);
    expect(calls.some(c => c.includes('web-token'))).toBe(false);
  });

  it('writes the env file 0600 and threads --web-token when a token is given', async () => {
    const { runner, calls } = makeRunner({
      crontab: { code: 1, stdout: '' },
      systemctl: { code: 0 },
    });
    const { ask, asked } = makeElicit({
      ...HAPPY,
      coordinatorUrl: 'http://10.0.0.5:8080',
      webToken: 'tok-en-123',
    });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = await workflow.run({}, makeCtx({ ask }) as never);
    const parsed = JSON.parse(
      (result as { toolResult?: string }).toolResult ?? ''
    ) as { ok: boolean; steps: { step: string; status: string }[] };

    expect(parsed.ok).toBe(true);
    expect(parsed.steps.find(s => s.step === 'env-file')?.status).toBe('done');

    const envPath = path.join(home, '.drone-swarm-memory', 'env');
    const envContent = await readFile(envPath, 'utf-8');
    expect(envContent).toBe(
      "export DRONE_COORDINATOR_WEB_TOKEN='tok-en-123'\n"
    );
    expect((await stat(envPath)).mode & 0o777).toBe(0o600);

    const hookScript = await readFile(
      path.join(home, '.drone-swarm-memory', 'bin', 'session-end-ingest.sh'),
      'utf-8'
    );
    expect(hookScript).toContain('. "$HOME/.drone-swarm-memory/env"');

    const probeCalls = calls.filter(c =>
      c.join(' ').includes('session list --limit 1')
    );
    expect(probeCalls.length).toBeGreaterThan(0);
    expect(probeCalls.some(c => c.includes('--web-token'))).toBe(true);
    expect(probeCalls.some(c => c.includes('tok-en-123'))).toBe(true);
    expect(probeCalls[0]).not.toContain('--web-token');
    expect(asked.map(a => a.id)).toContain('webToken');
  });

  it('writes no env file when the token is empty', async () => {
    const { runner } = makeRunner({ crontab: { code: 1, stdout: '' } });
    const { ask } = makeElicit({ ...HAPPY });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    await workflow.run({}, makeCtx({ ask }) as never);
    await expect(
      readFile(path.join(home, '.drone-swarm-memory', 'env'), 'utf-8')
    ).rejects.toThrow();
  });

  it('names the missing binary when drone-swarm is not on PATH', async () => {
    const { runner } = makeRunner({
      crontab: { code: 1, stdout: '' },
      binaryCheck: { code: 1 },
    });
    const { ask } = makeElicit({ ...HAPPY });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = await workflow.run({}, makeCtx({ ask }) as never);
    const parsed = JSON.parse(
      (result as { toolResult?: string }).toolResult ?? ''
    ) as { ok: boolean; message?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('drone-swarm binary was not found');
  });

  it('surfaces probe stderr in the not-reachable message', async () => {
    const { runner } = makeRunner({
      crontab: { code: 1, stdout: '' },
      probe: { code: 7, stderr: 'Failed to list sessions: 401' },
    });
    const { ask } = makeElicit({ ...HAPPY });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = await workflow.run({}, makeCtx({ ask }) as never);
    const parsed = JSON.parse(
      (result as { toolResult?: string }).toolResult ?? ''
    ) as { ok: boolean; message?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('drone-swarm exited 7');
    expect(parsed.message).toContain('Failed to list sessions: 401');
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
    const parsed = JSON.parse(
      (result as { toolResult?: string }).toolResult ?? ''
    ) as {
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
    const parsed = JSON.parse(
      (result as { toolResult?: string }).toolResult ?? ''
    ) as {
      steps: { step: string; status: string }[];
    };
    expect(parsed.steps.find(s => s.step === 'smoke')?.status).toBe('skipped');
    expect(
      calls.filter(c => c.join(' ').includes('session-end-ingest.sh sess'))
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
    const parsed = JSON.parse(
      (result as { toolResult?: string }).toolResult ?? ''
    ) as {
      ok: boolean;
      steps: { step: string; status: string; detail?: string }[];
    };
    const failed = parsed.steps.find(s => s.status === 'failed');
    expect(failed?.detail).toContain('syntax error');
    expect(parsed.ok).toBe(false);
  });

  it('falls back to instruct-only restart guidance when the agent cannot identify the launch mode', async () => {
    const { runner } = makeRunner({
      crontab: { code: 1, stdout: '' },
      systemctl: { code: 1 },
      docker: { code: 1 },
    });
    const { ask } = makeElicit({ ...HAPPY });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = await workflow.run(
      {},
      makeCtx({ ask }, () => 'launch=none restart=none') as never
    );
    const parsed = JSON.parse(
      (result as { toolResult?: string }).toolResult ?? ''
    ) as {
      pendingRestart: string[];
    };
    expect(parsed.pendingRestart).toHaveLength(1);
    expect(parsed.pendingRestart[0]).toContain('restart it yourself');
  });

  it('restarts using the agent-observed unit name, not the plugin id', async () => {
    const { runner, calls } = makeRunner({
      crontab: { code: 1, stdout: '' },
      systemctl: { code: 0 },
    });
    const { ask } = makeElicit({ ...HAPPY });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = await workflow.run(
      {},
      makeCtx(
        { ask },
        () =>
          'launch=systemd restart=systemctl restart drone-coordinator-prod.service'
      ) as never
    );
    expect(
      calls.some(
        c => c.join(' ') === 'systemctl restart drone-coordinator-prod.service'
      )
    ).toBe(true);
    const parsed = JSON.parse(
      (result as { toolResult?: string }).toolResult ?? ''
    ) as { pendingRestart: string[] };
    expect(parsed.pendingRestart).toHaveLength(0);
  });

  it('kickMessage follows the instruction-not-report contract and owns continueSession', async () => {
    const { runner } = makeRunner({
      crontab: { code: 1, stdout: '' },
      systemctl: { code: 0 },
    });
    const { ask } = makeElicit({ ...HAPPY });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const result = (await workflow.run({}, makeCtx({ ask }) as never)) as {
      kickMessage?: string;
      continueSession?: boolean;
      toolResult?: string;
    };
    expect(result.continueSession).toBe(true);
    expect(result.kickMessage).toContain('bootstrap__swarm-memory');
    expect(result.kickMessage).toContain('Report to the user');
    expect(result.kickMessage).toContain('followups');
  });

  it('asks the agent to discover launch for both servers when beacon is configured', async () => {
    const { runner } = makeRunner({
      crontab: { code: 1, stdout: '' },
      systemctl: { code: 0 },
    });
    const { ask } = makeElicit({ ...HAPPY, configureBeacon: 'yes' });
    const workflow = createSwarmMemoryWorkflow({ runner, home });
    const ctx = makeCtx({ ask });
    await workflow.run({}, ctx as never);
    expect((ctx as { agentCalls: string[] }).agentCalls.length).toBe(2);
  });

  it('generates a hook script with a librarian self-ingest guard', async () => {
    const { buildHookScript } =
      await import('../../../src/plugins/bootstrap/swarm-memory-scripts.js');
    const script = buildHookScript({
      coordinatorUrl: 'http://127.0.0.1:8080',
      webToken: '',
      configureBeacon: false,
      batchLimit: '5',
      cronSchedule: '0 * * * *',
      droneAgentPath: '/usr/local/bin/drone-agent',
      droneSwarmPath: '/usr/local/bin/drone-swarm',
    });

    // Guard reads the persona from `session get` (lightweight metadata), NOT
    // the full event log (which can be huge and truncate into malformed JSON)
    // and NOT the transcript string (which has no persona)...
    expect(script).toContain('session_persona=');
    expect(script).toContain('session get "$SESSION_ID"');
    expect(script).toContain('t.personaId');
    // ...compares against the librarian persona...
    expect(script).toContain(
      'if [ "$session_persona" = "$LIBRARIAN_PERSONA" ]'
    );
    // ...marks the session processed with a skip summary (never leaves it
    // ended, which would re-queue it every catch-up run)...
    expect(script).toContain(
      'skipped: librarian self-session (self-ingest guard)'
    );
    // ...and exits 0 (the coordinator trigger treats non-zero as failure).
    expect(script).toMatch(/self-ingest guard[\s\S]*exit 0/);
  });

  it('generated hook script is valid bash (self-ingest guard continuation)', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { buildHookScript } =
      await import('../../../src/plugins/bootstrap/swarm-memory-scripts.js');
    const run = promisify(execFile);
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const script = buildHookScript({
      coordinatorUrl: 'http://127.0.0.1:8080',
      webToken: '',
      configureBeacon: false,
      batchLimit: '5',
      cronSchedule: '0 * * * *',
      droneAgentPath: '/usr/local/bin/drone-agent',
      droneSwarmPath: '/usr/local/bin/drone-swarm',
    });
    const tmp = path.join(os.tmpdir(), `hook-guard-${Date.now()}.sh`);
    try {
      await fs.writeFile(tmp, script, { mode: 0o755 });
      await run('bash', ['-n', tmp]);
    } finally {
      await fs.rm(tmp, { force: true });
    }
  });

  it('catch-up script filters librarian sessions at the list level (no agent spawn)', async () => {
    const { buildCatchupScript } =
      await import('../../../src/plugins/bootstrap/swarm-memory-scripts.js');
    const script = buildCatchupScript({
      coordinatorUrl: 'http://127.0.0.1:8080',
      webToken: '',
      configureBeacon: false,
      batchLimit: '5',
      cronSchedule: '0 * * * *',
      droneAgentPath: '/usr/local/bin/drone-agent',
      droneSwarmPath: '/usr/local/bin/drone-swarm',
    });

    // The list query carries personaId so the guard can dismiss librarian
    // sessions without spawning an agent (spawning one just to learn it is a
    // librarian session creates a new session the next catch-up picks up).
    expect(script).toContain('s.personaId');
    expect(script).toContain('if [ "$persona" = "$LIBRARIAN_PERSONA" ]');
    expect(script).toContain(
      'skipped: librarian self-session (list-level guard)'
    );
    // The dismissed branch must NOT call the ingest hook (no agent spawn).
    const ifStart = script.indexOf('if [ "$persona" = "$LIBRARIAN_PERSONA" ]');
    const dismissedBranch = script.slice(
      ifStart,
      script.indexOf('fi', ifStart)
    );
    expect(dismissedBranch).not.toContain('INGEST_HOOK');
    expect(dismissedBranch).toContain('session processed');
  });

  it('generated scripts use the discovered absolute binary paths', async () => {
    const { buildHookScript, buildCatchupScript } =
      await import('../../../src/plugins/bootstrap/swarm-memory-scripts.js');
    const settings = {
      coordinatorUrl: 'http://127.0.0.1:8080',
      webToken: '',
      configureBeacon: false,
      batchLimit: '5',
      cronSchedule: '0 * * * *',
      droneAgentPath: '/opt/drone/bin/drone-agent',
      droneSwarmPath: '/opt/drone/bin/drone-swarm',
    };
    const hook = buildHookScript(settings);
    const catchup = buildCatchupScript(settings);

    // Both scripts bind the absolute paths and invoke them (cron / session-end
    // hooks run in minimal PATH environments, so bare names may not resolve).
    expect(hook).toContain('DRONE_SWARM="/opt/drone/bin/drone-swarm"');
    expect(hook).toContain('DRONE_AGENT="/opt/drone/bin/drone-agent"');
    expect(hook).toContain('"$DRONE_SWARM" --coordinator');
    expect(hook).toContain('"$DRONE_AGENT" --output-json');
    expect(catchup).toContain('DRONE_SWARM="/opt/drone/bin/drone-swarm"');
    expect(catchup).toContain('"$DRONE_SWARM" --coordinator');
  });
});
