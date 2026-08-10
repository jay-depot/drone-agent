import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export interface SubagentResult {
  /**
   * The parsed result from the subagent (if successful).
   */
  result?: string;
  /**
   * The error message (if failed).
   */
  error?: string;
  /**
   * The exit code of the subagent process.
   */
  exitCode: number | undefined;
  /**
   * Raw stdout from the subagent.
   */
  stdout: string;
  /**
   * Raw stderr from the subagent.
   */
  stderr: string;
  /**
   * Whether the subagent timed out.
   */
  timedOut: boolean;
  /**
   * The subagent's unique ID.
   */
  subagentId: string;
}

export interface LaunchSubagentOptions {
  /**
   * The task/prompt to send to the subagent.
   */
  task: string;
  /**
   * Optional persona override.
   */
  persona?: string;
  /**
   * Activity timeout in milliseconds (default: 300000 = 5 minutes).
   * Resets on any progress from the subagent.
   */
  timeout?: number;
  /**
   * Hard cap timeout in milliseconds (default: 3600000 = 1 hour).
   * Never resets, prevents runaway subagents.
   */
  hardCap?: number;
  /**
   * Path to the drone-agent executable (auto-detected if not provided).
   */
  execPath?: string;
}

interface PendingSubagent {
  resolve: (result: SubagentResult) => void;
  reject: (error: Error) => void;
  activityTimer: ReturnType<typeof setTimeout> | null;
  hardCapTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Track pending subagents for cleanup.
 */
const pendingSubagents = new Map<string, PendingSubagent>();

/**
 * Default activity timeout for subagent dispatch (5 minutes).
 */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Default hard cap for subagent execution (1 hour).
 */
const DEFAULT_HARD_CAP_MS = 3_600_000;

/**
 * Generate a unique subagent ID for testing.
 */
function generateSubagentId(): string {
  return `test-subagent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Parse NDJSON output from a subagent and extract the return event.
 */
function parseNdjsonOutput(stdout: string): {
  result?: string;
  error?: string;
} {
  const lines = stdout.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.kind === 'return') {
        return {
          result: event.result as string | undefined,
          error: event.error as string | undefined,
        };
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  return {};
}

/**
 * Launch a subagent and capture its output.
 * Uses the echo LLM (or whatever LLM is configured) for responses.
 *
 * @example
 * ```ts
 * const result = await launchSubagent({
 *   task: 'Say hello in 5 words or less',
 *   timeout: 30000,
 * });
 * console.log(result.result);
 * ```
 */
export async function launchSubagent(
  options: LaunchSubagentOptions
): Promise<SubagentResult> {
  const {
    task,
    persona,
    timeout = DEFAULT_TIMEOUT_MS,
    hardCap = DEFAULT_HARD_CAP_MS,
    execPath: providedExecPath,
  } = options;

  const subagentId = providedExecPath
    ? generateSubagentId()
    : `test-subagent-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  // Find the drone-agent executable
  const execPath =
    providedExecPath ??
    resolve(process.cwd(), 'drone-agent', 'bin', 'drone-agent');

  // Build command args
  const args = ['--subagent-id', subagentId, '--output-json', '--once'];

  if (persona) {
    args.push('--persona', persona);
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let timedOut = false;
    const collectedOutput: string[] = [];
    let stderr = '';
    let exitCode: number | undefined;

    // Spawn the subagent process
    const child = spawn(execPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DRONE_SUBAGENT_ID: subagentId,
        DRONE_PERSONA: persona,
      },
    });

    // Activity timeout — resets on any NDJSON event from subagent
    let activityTimer!: ReturnType<typeof setTimeout>;
    const startActivityTimer = () => {
      activityTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Give it a moment to terminate gracefully, then force kill
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1000);
      }, timeout);
    };
    startActivityTimer();

    // Hard cap — never resets, prevents runaway subagents
    const hardCapTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGKILL');
        }
      }, 1000);
    }, hardCap);

    // Track this pending subagent for cleanup
    pendingSubagents.set(subagentId, {
      resolve: resolvePromise,
      reject: rejectPromise,
      activityTimer,
      hardCapTimer,
    });

    // Write kickoff to stdin
    const stdin = child.stdin;
    if (!stdin) {
      clearTimeout(activityTimer);
      clearTimeout(hardCapTimer);
      pendingSubagents.delete(subagentId);
      rejectPromise(new Error('Failed to open stdin for subagent'));
      return;
    }

    const kickoffEvent = JSON.stringify({
      type: 'kickoff',
      task: task,
    });
    stdin.write(kickoffEvent + '\n');
    stdin.end();

    // Collect stdout
    child.stdout?.on('data', (data: Buffer) => {
      const lines = data
        .toString()
        .split('\n')
        .filter(l => l.trim());
      collectedOutput.push(...lines);

      // Any NDJSON event resets the activity timer
      for (const line of lines) {
        try {
          JSON.parse(line);
          clearTimeout(activityTimer);
          startActivityTimer();
        } catch {
          // Skip invalid JSON
        }
      }
    });

    // Collect stderr
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    // Handle process exit
    child.on('close', code => {
      clearTimeout(activityTimer);
      clearTimeout(hardCapTimer);
      pendingSubagents.delete(subagentId);

      exitCode = code ?? undefined;
      const stdoutText = collectedOutput.join('\n');
      const { result, error } = parseNdjsonOutput(stdoutText);

      if (timedOut) {
        resolvePromise({
          error: 'Subagent timed out',
          timedOut: true,
          exitCode,
          stdout: stdoutText,
          stderr,
          subagentId,
        });
      } else if (exitCode !== 0 && exitCode !== undefined) {
        resolvePromise({
          error:
            error ||
            `Subagent exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
          timedOut: false,
          exitCode,
          stdout: stdoutText,
          stderr,
          subagentId,
        });
      } else if (!result) {
        resolvePromise({
          error: 'Subagent did not return a result',
          exitCode,
          timedOut: false,
          stdout: stdoutText,
          stderr,
          subagentId,
        });
      } else {
        resolvePromise({
          result,
          exitCode,
          stdout: stdoutText,
          stderr,
          subagentId,
          timedOut: false,
        });
      }
    });

    child.on('error', (err: Error) => {
      clearTimeout(activityTimer);
      clearTimeout(hardCapTimer);
      pendingSubagents.delete(subagentId);
      rejectPromise(err);
    });
  });
}

export interface LaunchParallelOptions {
  /**
   * Factory function to generate tasks for each subagent.
   */
  taskFactory: (index: number) => string;
  /**
   * Optional persona override for all subagents.
   */
  persona?: string;
  /**
   * Timeout in milliseconds for each subagent (default: 300000 = 5 minutes).
   */
  timeout?: number;
  /**
   * Maximum number of concurrent subagents (default: unlimited).
   */
  maxConcurrency?: number;
  /**
   * Path to the drone-agent executable.
   */
  execPath?: string;
}

/**
 * Run multiple subagents in parallel and collect all results.
 *
 * @example
 * ```ts
 * const results = await launchParallelSubagents(3, {
 *   taskFactory: (i) => `Task ${i}: Calculate ${i} + ${i}`,
 *   maxConcurrency: 2, // Run 2 at a time
 * });
 * ```
 */
export async function launchParallelSubagents(
  count: number,
  options: LaunchParallelOptions
): Promise<SubagentResult[]> {
  const { taskFactory, persona, timeout, maxConcurrency, execPath } = options;

  const results: SubagentResult[] = [];
  const running: Promise<SubagentResult>[] = [];
  const runningCount = new Set<number>();

  for (let i = 0; i < count; i++) {
    const task = taskFactory(i);

    const promise = launchSubagent({
      task,
      persona,
      timeout,
      execPath,
    });

    running.push(promise);

    const index = i;
    promise.then(result => {
      runningCount.delete(index);
      results[index] = result;
    });

    // Handle concurrency limit
    if (maxConcurrency && runningCount.size >= maxConcurrency) {
      await Promise.race(running);
    }
  }

  // Wait for all to complete
  const allResults = await Promise.all(running);

  // Sort results by original index (since they may complete out of order)
  return allResults;
}

/**
 * Create a subagent that always times out.
 * Useful for testing timeout handling.
 *
 * @example
 * ```ts
 * const result = await launchTimeoutSubagent(1000);
 * expect(result.timedOut).toBe(true);
 * ```
 */
export async function launchTimeoutSubagent(
  timeoutMs: number = 100
): Promise<SubagentResult> {
  // Create an infinite loop task that will never complete
  const infiniteTask = 'Perform an infinite computation: while(true) { }';

  return launchSubagent({
    task: infiniteTask,
    timeout: timeoutMs,
  });
}

export type ErrorType = 'crash' | 'exception' | 'no-return';

/**
 * Create a subagent that errors in a specific way.
 * - 'crash': Subagent process exits unexpectedly
 * - 'exception': Subagent throws an unhandled exception
 * - 'no-return': Subagent completes but never calls return tool
 *
 * @example
 * ```ts
 * const result = await launchErrorSubagent('crash');
 * expect(result.exitCode).not.toBe(0);
 * ```
 */
export async function launchErrorSubagent(
  errorType: ErrorType,
  options: Partial<LaunchSubagentOptions> = {}
): Promise<SubagentResult> {
  let task: string;

  switch (errorType) {
    case 'crash':
      // Task that causes the process to crash
      task = 'Exit immediately with code 1';
      break;
    case 'exception':
      // Task that causes an unhandled exception
      task = 'Throw an unhandled error: throw new Error("test error")';
      break;
    case 'no-return':
      // Task that completes but doesn't use the return tool
      task = 'Say "hello" directly without using subagent.return';
      break;
    default:
      task = options.task ?? 'Fail with unknown error';
  }

  return launchSubagent({
    ...options,
    task,
  });
}

/**
 * Cancel all pending subagents.
 * Useful for cleanup in test teardown.
 */
export function cancelAllSubagents(): void {
  for (const [subagentId, pending] of pendingSubagents) {
    if (pending.activityTimer) {
      clearTimeout(pending.activityTimer);
    }
    if (pending.hardCapTimer) {
      clearTimeout(pending.hardCapTimer);
    }
    pendingSubagents.delete(subagentId);
  }
}

/**
 * Get the count of currently pending subagents.
 */
export function getPendingSubagentCount(): number {
  return pendingSubagents.size;
}
