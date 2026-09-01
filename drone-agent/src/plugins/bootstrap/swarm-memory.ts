import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DroneElicitation, DroneWorkflow } from 'drone-core';
import { mergeConfig, validateConfigFile } from 'drone-swarm-common';
import {
  CATCHUP_SCRIPT_NAME,
  HOOK_SCRIPT_NAME,
  buildCatchupScript,
  buildHookScript,
  type SwarmMemorySettings,
} from './swarm-memory-scripts.js';
export type { SwarmMemorySettings };

export type RunResult = { code: number; stdout: string; stderr: string };

export type CommandRunner = (
  cmd: string[],
  options?: { input?: string }
) => Promise<RunResult>;

const MEMORY_DIR = '.drone-swarm-memory';
const DEFAULT_COORDINATOR_URL = 'http://localhost:8080';
const DEFAULT_BATCH_LIMIT = '5';
const DEFAULT_CRON_SCHEDULE = '0 * * * *';

type Discovery = {
  settings: SwarmMemorySettings;
  coordinatorReachable: boolean;
  probeFailureHint: string;
  launchMode: 'systemd' | 'docker' | 'unknown';
  coordinatorConfigPath: string;
  beaconConfigPath: string;
  coordinatorConfigRaw: string | undefined;
  beaconConfigRaw: string | undefined;
};

type StepReport = {
  step: string;
  status: 'done' | 'skipped' | 'failed' | 'pending-restart-needed';
  detail?: string;
};

/** Default runner: node:child_process spawn with optional stdin input. */
export function createExecFileRunner(): CommandRunner {
  return (cmd, options) =>
    new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      const child = spawn(cmd[0] ?? '', cmd.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (d: Buffer) => {
        stdout += String(d);
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += String(d);
      });
      child.on('error', err => {
        resolve({ code: -1, stdout, stderr: String(err) });
      });
      child.on('close', code => {
        resolve({ code: code ?? -1, stdout, stderr });
      });
      if (options?.input !== undefined) {
        child.stdin?.write(options.input);
      }
      child.stdin?.end();
    });
}

export function hookScriptPath(home = os.homedir()): string {
  return path.join(home, MEMORY_DIR, 'bin', HOOK_SCRIPT_NAME);
}

export function catchupScriptPath(home = os.homedir()): string {
  return path.join(home, MEMORY_DIR, 'bin', CATCHUP_SCRIPT_NAME);
}

export function coordinatorConfigPath(home = os.homedir()): string {
  return path.join(home, '.drone-coordinator', 'config.json');
}

export function beaconConfigPath(home = os.homedir()): string {
  return path.join(home, '.drone-beacon', 'config.json');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  if (!(await exists(filePath))) {
    return undefined;
  }
  return readFile(filePath, 'utf8');
}

/**
 * Atomic write: temp file + rename so a crash never leaves a truncated
 * config. Scripts get chmod 0755 (the umask would strip the exec bit).
 */
async function atomicWrite(
  filePath: string,
  content: string,
  mode?: number
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, 'utf-8');
  if (mode !== undefined) {
    await chmod(tmp, mode);
  }
  await rename(tmp, filePath);
}

export function mergeSessionEndTrigger(
  existingRaw: string | undefined,
  hookPath: string
): unknown {
  const existing =
    existingRaw !== undefined ? (JSON.parse(existingRaw) as object) : {};
  return mergeConfig(existing, {
    sessionEnd: { type: 'command', command: `${hookPath} {session_id}` },
  });
}

export function cronLineFor(schedule: string, scriptPath: string): string {
  return `${schedule} bash ${scriptPath} >> $HOME/.drone-swarm-memory/catch-up.log 2>&1`;
}

async function confirm(
  elicit: DroneElicitation,
  id: string,
  prompt: string
): Promise<boolean> {
  const answers = await elicit.ask([
    {
      id,
      prompt,
      choices: [
        { value: 'yes', label: 'Yes — apply it' },
        { value: 'no', label: 'No — stop here' },
      ],
      defaultValue: 'no',
    },
  ]);
  return answers[id] === 'yes';
}

async function detectLaunchMode(
  runner: CommandRunner
): Promise<Discovery['launchMode']> {
  const systemd = await runner(['systemctl', 'status', 'drone-coordinator']);
  if (systemd.code === 0 || systemd.code === 3) {
    return 'systemd';
  }
  const docker = await runner([
    'docker',
    'ps',
    '--format',
    '{{.Names}} {{.Image}}',
  ]);
  if (docker.code === 0 && docker.stdout.includes('drone-coordinator')) {
    return 'docker';
  }
  return 'unknown';
}

type ProbeFailure =
  | { reason: 'binary-missing' }
  | { reason: 'exit'; code: number; stderr: string; stdout: string }
  | { reason: 'ok' };

/**
 * Turn a raw probe result into a human hint for the failure message, so
 * "not reachable" distinguishes a missing drone-swarm binary from a dead
 * server (exit/stderr) instead of hiding the cause.
 */
export function describeProbeFailure(failure: ProbeFailure): string {
  switch (failure.reason) {
    case 'binary-missing':
      return 'the drone-swarm binary was not found on PATH — install/link the drone-swarm package (it is what the ingest hook and catch-up job call)';
    case 'exit':
      return `drone-swarm exited ${failure.code}: ${
        failure.stderr.trim() ||
        failure.stdout.trim().slice(0, 200) ||
        '(no output)'
      }`;
    case 'ok':
      return '';
  }
}

/**
 * Validate the probe result into a structured outcome: binary presence
 * first (spawn failures resolve to code -1 and are indistinguishable from
 * connection failures), then exit status.
 */
function classifyProbe(result: {
  code: number;
  stdout: string;
  stderr: string;
}): ProbeFailure {
  if (result.code === -1) {
    return { reason: 'binary-missing' };
  }
  if (result.code !== 0) {
    return {
      reason: 'exit',
      code: result.code,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }
  return { reason: 'ok' };
}

async function probeCoordinator(
  runner: CommandRunner,
  url: string,
  webToken: string
): Promise<ProbeFailure> {
  const binaryCheck = await runner([
    'sh',
    '-c',
    'command -v drone-swarm >/dev/null 2>&1',
  ]);
  if (binaryCheck.code !== 0) {
    return { reason: 'binary-missing' };
  }
  const result = await runner([
    'drone-swarm',
    '--coordinator',
    url,
    ...(webToken ? ['--web-token', webToken] : []),
    'session',
    'list',
    '--limit',
    '1',
  ]);
  return classifyProbe(result);
}

async function discover(
  elicit: DroneElicitation,
  runner: CommandRunner,
  home: string
): Promise<Discovery | undefined> {
  const reachableDefault = await probeCoordinator(
    runner,
    DEFAULT_COORDINATOR_URL,
    ''
  );
  const answers = await elicit.ask([
    {
      id: 'coordinatorUrl',
      prompt: `Swarm memory setup. I detected the coordinator ${
        reachableDefault.reason === 'ok' ? 'REACHABLE' : 'NOT reachable'
      } at ${DEFAULT_COORDINATOR_URL}.\n\nWhich URL should the pipeline talk to?${
        reachableDefault.reason === 'ok'
          ? ''
          : `\n\nProbe failure: ${describeProbeFailure(reachableDefault)}`
      }`,
      freeform: true,
      placeholder: DEFAULT_COORDINATOR_URL,
      defaultValue: DEFAULT_COORDINATOR_URL,
    },
    {
      id: 'webToken',
      prompt:
        'Web token for the coordinator web port? (Leave empty when the coordinator is local — loopback needs no token.)',
      freeform: true,
      placeholder: '(empty if local)',
      defaultValue: '',
    },
    {
      id: 'configureBeacon',
      prompt:
        'Also configure the beacon layer (a sessionEnd trigger at the beacon fires even when the coordinator is unreachable)?',
      choices: [
        { value: 'no', label: 'No — coordinator only (recommended)' },
        { value: 'yes', label: 'Yes — beacon too' },
      ],
      defaultValue: 'no',
    },
    {
      id: 'batchLimit',
      prompt: 'Catch-up job: how many ended sessions per run (newest first)?',
      freeform: true,
      placeholder: DEFAULT_BATCH_LIMIT,
      defaultValue: DEFAULT_BATCH_LIMIT,
    },
    {
      id: 'cronSchedule',
      prompt: 'Cron schedule for the catch-up job?',
      freeform: true,
      placeholder: DEFAULT_CRON_SCHEDULE,
      defaultValue: DEFAULT_CRON_SCHEDULE,
    },
  ]);

  const url = (
    (answers.coordinatorUrl as string) || DEFAULT_COORDINATOR_URL
  ).trim();
  const settings: SwarmMemorySettings = {
    coordinatorUrl: url,
    webToken: ((answers.webToken as string) || '').trim(),
    configureBeacon: answers.configureBeacon === 'yes',
    batchLimit:
      ((answers.batchLimit as string) || '').trim() || DEFAULT_BATCH_LIMIT,
    cronSchedule:
      ((answers.cronSchedule as string) || '').trim() || DEFAULT_CRON_SCHEDULE,
  };
  if (!/^\*\/\d+|^\d+/.test(settings.cronSchedule)) {
    return undefined;
  }

  const probe = await probeCoordinator(runner, url, settings.webToken);
  return {
    settings,
    coordinatorReachable: probe.reason === 'ok',
    probeFailureHint: describeProbeFailure(probe),
    launchMode: await detectLaunchMode(runner),
    coordinatorConfigPath: coordinatorConfigPath(home),
    beaconConfigPath: beaconConfigPath(home),
    coordinatorConfigRaw: await readIfPresent(coordinatorConfigPath(home)),
    beaconConfigRaw: await readIfPresent(beaconConfigPath(home)),
  };
}

async function restartServer(
  elicit: DroneElicitation,
  runner: CommandRunner,
  discovery: Discovery,
  server: 'coordinator' | 'beacon',
  pendingRestart: string[]
): Promise<void> {
  if (discovery.launchMode === 'unknown') {
    pendingRestart.push(
      `${server}: launch mode not detected — restart it yourself to activate the config`
    );
    return;
  }
  const command =
    discovery.launchMode === 'systemd'
      ? `systemctl restart ${server}`
      : `docker restart ${server}`;
  const approved = await confirm(
    elicit,
    `restart-${server}`,
    `The ${server} must restart to load the new config (launch mode: ${discovery.launchMode}).\n\nRun: ${command}`
  );
  if (!approved) {
    pendingRestart.push(
      `${server}: restart pending (declined) — run: ${command}`
    );
    return;
  }
  const result = await runner(command.split(' '));
  if (result.code !== 0) {
    pendingRestart.push(
      `${server}: restart command failed (${result.code}): ${result.stderr.trim()}`
    );
    return;
  }
  if (server === 'coordinator') {
    discovery.coordinatorReachable =
      (
        await probeCoordinator(
          runner,
          discovery.settings.coordinatorUrl,
          discovery.settings.webToken
        )
      ).reason === 'ok';
  }
}

async function installServerConfig(
  elicit: DroneElicitation,
  server: 'coordinator' | 'beacon',
  filePath: string,
  existingRaw: string | undefined,
  hookPath: string,
  reports: StepReport[]
): Promise<void> {
  const merged = mergeSessionEndTrigger(existingRaw, hookPath);
  const problems = validateConfigFile(merged);
  if (problems.length > 0) {
    reports.push({
      step: `config-${server}`,
      status: 'failed',
      detail: `merged config invalid: ${problems.join('; ')}`,
    });
    return;
  }
  const showBefore = existingRaw ? '(existing file)' : '(new file)';
  const approved = await confirm(
    elicit,
    `write-config-${server}`,
    `Write the sessionEnd trigger to ${filePath}?\n\nBefore: ${showBefore}\nAfter:\n\n${JSON.stringify(merged, null, 2)}\n\nTakes effect when the ${server} restarts.`
  );
  if (!approved) {
    reports.push({
      step: `config-${server}`,
      status: 'skipped',
      detail: 'user declined',
    });
    return;
  }
  await atomicWrite(filePath, `${JSON.stringify(merged, null, 2)}\n`);
  reports.push({ step: `config-${server}`, status: 'done', detail: filePath });
}

async function installCronEntry(
  elicit: DroneElicitation,
  runner: CommandRunner,
  discovery: Discovery,
  catchupPath: string,
  reports: StepReport[]
): Promise<void> {
  const line = cronLineFor(discovery.settings.cronSchedule, catchupPath);
  const existing = await runner(['crontab', '-l']);
  const currentCrontab =
    existing.code === 0 ? existing.stdout : '# (no crontab yet)';
  const updated =
    existing.code === 0
      ? `${existing.stdout.trimEnd()}\n${line}\n`
      : `${line}\n`;

  const approved = await confirm(
    elicit,
    'write-cron',
    `Install the catch-up cron entry?\n\nBefore:\n${currentCrontab}\n\nAfter (appending last line):\n${line}\n\nSchedule: ${discovery.settings.cronSchedule}`
  );
  if (!approved) {
    reports.push({ step: 'cron', status: 'skipped', detail: 'user declined' });
    return;
  }
  const install = await runner(['crontab', '-'], { input: updated });
  if (install.code !== 0) {
    reports.push({
      step: 'cron',
      status: 'failed',
      detail: `crontab install failed: ${install.stderr.trim()}`,
    });
    return;
  }
  reports.push({ step: 'cron', status: 'done', detail: line });
}

async function smokeTest(
  elicit: DroneElicitation,
  runner: CommandRunner,
  discovery: Discovery,
  hookPath: string,
  reports: StepReport[]
): Promise<void> {
  const listing = await runner([
    'drone-swarm',
    '--coordinator',
    discovery.settings.coordinatorUrl,
    ...(discovery.settings.webToken
      ? ['--web-token', discovery.settings.webToken]
      : []),
    'session',
    'list',
    '--status',
    'ended',
    '--limit',
    '5',
  ]);
  if (listing.code !== 0) {
    reports.push({
      step: 'smoke',
      status: 'skipped',
      detail: 'could not list ended sessions (coordinator unreachable?)',
    });
    return;
  }
  const endedIds = listing.stdout
    .trim()
    .split('\n')
    .join(' ')
    .match(/"id"\s*:\s*"([^"]+)"/g)
    ?.map(m => m.replace(/"id"\s*:\s*"/, '').replace('"', ''))
    .slice(0, 5);

  const approved = await confirm(
    elicit,
    'smoke',
    `Smoke test on REAL conversations?\n\nEnded sessions available: ${
      endedIds && endedIds.length > 0 ? endedIds.join(', ') : '(none)'
    }\n\nSide effects: the chosen session is permanently marked processed and real wiki pages are written (editable afterward). This runs the same path production uses.`
  );
  if (!approved) {
    reports.push({ step: 'smoke', status: 'skipped', detail: 'user declined' });
    return;
  }

  const answer = await elicit.ask([
    {
      id: 'smokeSessionId',
      prompt: 'Which ended session should I push through the hook?',
      freeform: true,
      placeholder: endedIds?.[0] ?? '',
      defaultValue: endedIds?.[0] ?? '',
    },
  ]);
  const smokeId = ((answer.smokeSessionId as string) || '').trim();
  if (!smokeId) {
    reports.push({
      step: 'smoke',
      status: 'skipped',
      detail: 'no session id given',
    });
    return;
  }
  const run = await runner(['bash', hookPath, smokeId]);
  if (run.code !== 0) {
    reports.push({
      step: 'smoke',
      status: 'failed',
      detail: `ingest hook failed: ${run.stderr.trim() || `exit ${run.code}`}`,
    });
    return;
  }
  const wiki = await runner([
    'drone-swarm',
    '--coordinator',
    discovery.settings.coordinatorUrl,
    ...(discovery.settings.webToken
      ? ['--web-token', discovery.settings.webToken]
      : []),
    'wiki',
    'search',
    smokeId,
  ]);
  reports.push({
    step: 'smoke',
    status: 'done',
    detail: `session ${smokeId} ingested; wiki search exit ${wiki.code}`,
  });
}

async function runStaticValidation(
  runner: CommandRunner,
  discovery: Discovery,
  hookPath: string,
  catchupPath: string,
  reports: StepReport[]
): Promise<void> {
  for (const script of [hookPath, catchupPath]) {
    const check = await runner(['bash', '-n', script]);
    reports.push(
      check.code === 0
        ? {
            step: `bash-n:${path.basename(script)}`,
            status: 'done',
            detail: 'syntax ok',
          }
        : {
            step: `bash-n:${path.basename(script)}`,
            status: 'failed',
            detail: check.stderr.trim(),
          }
    );
  }
  const coordinatorRaw = await readIfPresent(discovery.coordinatorConfigPath);
  if (coordinatorRaw !== undefined) {
    const problems = validateConfigFile(JSON.parse(coordinatorRaw) as object);
    reports.push(
      problems.length === 0
        ? { step: 'validate-config-coordinator', status: 'done' }
        : {
            step: 'validate-config-coordinator',
            status: 'failed',
            detail: problems.join('; '),
          }
    );
  }
  const crontab = await runner(['crontab', '-l']);
  const cronOk =
    crontab.code === 0 && crontab.stdout.includes(path.basename(catchupPath));
  reports.push({
    step: 'cron-present',
    status: cronOk ? 'done' : 'failed',
    detail: cronOk ? undefined : 'catch-up entry not found in crontab',
  });
}

export type SwarmMemoryWorkflowOptions = {
  runner?: CommandRunner;
  home?: string;
};

export function createSwarmMemoryWorkflow(
  options: SwarmMemoryWorkflowOptions = {}
): DroneWorkflow {
  const runner = options.runner ?? createExecFileRunner();
  return {
    name: 'swarm-memory',
    description:
      'Set up the swarm memory pipeline on this coordinator host: sessionEnd ingest hook, cron catch-up job, server config triggers, and the wiki-librarian persona. Checks in before every change.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    run: async (_input, ctx) => {
      const reports: StepReport[] = [];
      const pendingRestart: string[] = [];
      const home = options.home ?? os.homedir();

      const discovery = await discover(ctx.elicit, runner, home);
      if (!discovery) {
        return {
          toolResult: JSON.stringify(
            { ok: false, message: 'Setup cancelled: invalid cron schedule.' },
            null,
            2
          ),
        };
      }

      if (!discovery.coordinatorReachable) {
        return {
          toolResult: JSON.stringify(
            {
              ok: false,
              message: `Coordinator at ${discovery.settings.coordinatorUrl} is not reachable (${discovery.probeFailureHint}). Start it (or fix the URL) and run the workflow again.`,
            },
            null,
            2
          ),
        };
      }

      // Hook script
      const hookPath = hookScriptPath(home);
      const hookScript = buildHookScript(discovery.settings);
      if (
        await confirm(
          ctx.elicit,
          'write-hook',
          `Create the session-end ingest hook script?\n\n${hookPath}\n\n${hookScript}`
        )
      ) {
        await atomicWrite(hookPath, hookScript, 0o755);
        reports.push({ step: 'hook-script', status: 'done', detail: hookPath });
      } else {
        reports.push({
          step: 'hook-script',
          status: 'skipped',
          detail: 'user declined — stopping here',
        });
        return summarize(
          discovery,
          reports,
          pendingRestart,
          'hook script declined'
        );
      }

      // Catch-up script + cron
      const catchupPath = catchupScriptPath(home);
      const catchupScript = buildCatchupScript(discovery.settings);
      if (
        await confirm(
          ctx.elicit,
          'write-catchup',
          `Create the gradual catch-up script?\n\n${catchupPath}\n\n${catchupScript}`
        )
      ) {
        await atomicWrite(catchupPath, catchupScript, 0o755);
        reports.push({
          step: 'catchup-script',
          status: 'done',
          detail: catchupPath,
        });
        await installCronEntry(
          ctx.elicit,
          runner,
          discovery,
          catchupPath,
          reports
        );
      } else {
        reports.push({
          step: 'catchup-script',
          status: 'skipped',
          detail: 'user declined',
        });
      }

      if (discovery.settings.webToken) {
        const escapedToken = discovery.settings.webToken.replace(/'/g, "'\\''");
        await atomicWrite(
          path.join(home, MEMORY_DIR, 'env'),
          `export DRONE_COORDINATOR_WEB_TOKEN='${escapedToken}'\n`,
          0o600
        );
        reports.push({
          step: 'env-file',
          status: 'done',
          detail: path.join(home, MEMORY_DIR, 'env'),
        });
      }

      // Server configs
      await installServerConfig(
        ctx.elicit,
        'coordinator',
        discovery.coordinatorConfigPath,
        discovery.coordinatorConfigRaw,
        hookPath,
        reports
      );
      if (discovery.settings.configureBeacon) {
        await installServerConfig(
          ctx.elicit,
          'beacon',
          discovery.beaconConfigPath,
          discovery.beaconConfigRaw,
          hookPath,
          reports
        );
      }

      // Restarts (ask-first)
      await restartServer(
        ctx.elicit,
        runner,
        discovery,
        'coordinator',
        pendingRestart
      );
      if (discovery.settings.configureBeacon) {
        await restartServer(
          ctx.elicit,
          runner,
          discovery,
          'beacon',
          pendingRestart
        );
      }

      // Static validation (always)
      await runStaticValidation(
        runner,
        discovery,
        hookPath,
        catchupPath,
        reports
      );

      // Smoke (confirm-first, real conversations)
      await smokeTest(ctx.elicit, runner, discovery, hookPath, reports);

      return summarize(discovery, reports, pendingRestart, 'completed');
    },
  };
}

function summarize(
  discovery: Discovery,
  reports: StepReport[],
  pendingRestart: string[],
  outcome: string
): { toolResult: string; kickMessage?: string } {
  const failed = reports.filter(r => r.status === 'failed');
  const result = {
    ok: failed.length === 0,
    outcome,
    steps: reports,
    pendingRestart,
    settings: discovery.settings,
  };
  const lines = [
    `Swarm memory bootstrap ${outcome}.`,
    '',
    ...reports.map(
      r => `- ${r.step}: ${r.status}${r.detail ? ` — ${r.detail}` : ''}`
    ),
  ];
  if (pendingRestart.length > 0) {
    lines.push('', 'Pending restarts:');
    for (const item of pendingRestart) {
      lines.push(`- ${item}`);
    }
  }
  lines.push(
    '',
    'Sessions move active → stale → ended → processing → processed; the hook claims ended sessions and the catch-up script sweeps the queue hourly.'
  );
  return {
    toolResult: JSON.stringify(result, null, 2),
    kickMessage: lines.join('\n'),
  };
}
