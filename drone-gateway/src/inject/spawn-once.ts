import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveDroneExecutable } from 'drone-core';

const KILL_GRACE_MS = 5_000;

export interface SpawnOnceOptions {
  task: string;
  personaId?: string;
  workingDir?: string;
  model?: string;
  agentPath?: string;
  timeoutMs: number;
}

export class SpawnOnceTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnOnceTimeoutError';
  }
}

export class SpawnOnceFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpawnOnceFailureError';
  }
}

/**
 * Run a single one-shot agent turn and return the final chat message.
 *
 * Uses `drone-agent --once --output-json` (runJsonMode): the kickoff event is
 * written to the child's stdin, which is then closed (runJsonMode reads stdin
 * until EOF); NDJSON events stream to stdout. The final chat message is the
 * LAST `assistantMessage` emitted. Agent logs go to stderr and are ignored.
 */
export async function spawnOnce(opts: SpawnOnceOptions): Promise<string> {
  const executable = await resolveDroneExecutable({
    commandName: opts.agentPath ?? 'drone-agent',
  });

  const args = ['--once', '--output-json'];
  if (opts.personaId) args.push('--persona', opts.personaId);
  if (opts.workingDir) args.push('--working-dir', opts.workingDir);
  if (opts.model) args.push('--model', opts.model);

  const child = spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    ...(opts.workingDir ? { cwd: opts.workingDir } : {}),
  });

  child.stdin.write(
    JSON.stringify({ type: 'kickoff', task: opts.task }) + '\n'
  );
  child.stdin.end();

  let finalMessage = '';
  let lastError: string | undefined;

  const rl = createInterface({ input: child.stdout });
  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const event = JSON.parse(trimmed) as {
        kind?: string;
        content?: string;
        message?: string;
      };
      if (
        event.kind === 'assistantMessage' &&
        typeof event.content === 'string'
      ) {
        finalMessage = event.content;
      } else if (event.kind === 'error' && typeof event.message === 'string') {
        lastError = event.message;
      }
    } catch {
      // Ignore non-JSON lines (stray logs).
    }
  });
  child.stderr.resume();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
  }, opts.timeoutMs);

  const exitCode = await new Promise<number | null>(resolve => {
    child.on('close', code => resolve(code));
    child.on('error', () => resolve(-1));
  });
  clearTimeout(timer);
  rl.close();

  if (timedOut) {
    throw new SpawnOnceTimeoutError(
      `Agent exceeded --timeout (${opts.timeoutMs} ms)`
    );
  }
  if (exitCode !== 0) {
    throw new SpawnOnceFailureError(
      lastError ?? `Agent exited with code ${exitCode}`
    );
  }
  return finalMessage;
}
