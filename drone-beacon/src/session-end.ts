import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SessionEndTrigger } from 'drone-swarm-common';
import { logger } from './logger.js';
import { spawnAgent } from './spawner.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const ESCALATION_KILL_GRACE_MS = 200;
const FALLBACK_SETTLE_GRACE_MS = 1000;
// Session IDs are substituted verbatim into a shell command, so they must be
// restricted to a safe charset to prevent command injection via the sync route.
const SESSION_ID_SAFE = /^[a-zA-Z0-9._-]+$/;

export interface SessionEndHookConfig {
  trigger?: SessionEndTrigger;
  beaconId: string;
  commandTimeoutMs?: number;
}

export interface SessionEndHookResult {
  ran: boolean;
  kind: 'none' | 'command' | 'spawn';
  error?: string;
}

let hookConfig: SessionEndHookConfig | undefined;

/**
 * Install the session-end trigger parsed from the config file. Called once
 * during startup; without it {@link runSessionEndHook} is a no-op.
 */
export function configureSessionEndHook(config: SessionEndHookConfig): void {
  hookConfig = config;
}

function substituteSessionId(command: string, sessionId: string): string {
  return command.replaceAll('{session_id}', sessionId);
}

async function runCommandTrigger(
  command: string,
  timeoutMs: number,
  sessionId: string
): Promise<SessionEndHookResult> {
  if (!SESSION_ID_SAFE.test(sessionId)) {
    return {
      ran: true,
      kind: 'command',
      error: `refusing to run session-end command for unsafe session id "${sessionId}"`,
    };
  }
  const finalCommand = substituteSessionId(command, sessionId);
  return new Promise(resolve => {
    let settled = false;
    const settle = (result: SessionEndHookResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    // detached:true makes the shell a process-group leader so a timeout can
    // kill the whole tree; without it, forked grandchildren inherit the stdio
    // pipes and hold the close event (and this promise) hostage.
    const child = spawn('/bin/sh', ['-c', finalCommand], {
      timeout: timeoutMs,
      detached: true,
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      logger.info(`[session-end:${sessionId}] ${chunk.toString().trim()}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      logger.warn(`[session-end:${sessionId}] ${chunk.toString().trim()}`);
    });

    child.on('error', err => {
      logger.warn(
        `Session-end command failed to start for session ${sessionId}: ${err}`
      );
      settle({ ran: true, kind: 'command', error: String(err) });
    });

    child.on('timeout', () => {
      logger.warn(
        `Session-end command timed out after ${timeoutMs}ms for session ${sessionId}; killing process group`
      );
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        // Group already gone; the close handler will settle.
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // Already dead.
        }
      }, ESCALATION_KILL_GRACE_MS).unref();
    });

    child.on('close', (code, signal) => {
      if (code === 0) {
        logger.info(`Session-end command completed for session ${sessionId}`);
        settle({ ran: true, kind: 'command' });
      } else if (code === null && signal !== null) {
        logger.warn(
          `Session-end command terminated by ${signal} after ${timeoutMs}ms for session ${sessionId}`
        );
        settle({
          ran: true,
          kind: 'command',
          error: `terminated by ${signal} after ${timeoutMs}ms`,
        });
      } else {
        logger.warn(
          `Session-end command exited with code ${code} for session ${sessionId}`
        );
        settle({ ran: true, kind: 'command', error: `exit code ${code}` });
      }
    });

    // Last-resort settlement: covers processes that escaped the group via
    // setsid(2). Unref'd so it never holds the event loop open.
    setTimeout(
      () =>
        settle({
          ran: true,
          kind: 'command',
          error: `timed out after ${timeoutMs}ms`,
        }),
      timeoutMs + FALLBACK_SETTLE_GRACE_MS
    ).unref();
  });
}

async function runSpawnTrigger(
  trigger: Extract<SessionEndTrigger, { type: 'spawn' }>,
  sessionId: string
): Promise<SessionEndHookResult> {
  const targetBeaconId = trigger.beaconId ?? hookConfig?.beaconId;
  if (!targetBeaconId || targetBeaconId !== hookConfig?.beaconId) {
    logger.warn(
      `Session-end spawn trigger targets beacon "${trigger.beaconId}" but this beacon is "${hookConfig?.beaconId}"; skipping.`
    );
    return { ran: false, kind: 'spawn', error: 'beaconId mismatch' };
  }
  try {
    const spawnId = randomUUID();
    const agentId = `agent-${randomUUID()}`;
    await spawnAgent(
      spawnId,
      agentId,
      trigger.persona,
      `Session ${sessionId} ended (session-end trigger)`,
      undefined
    );
    logger.info(
      `Session-end spawn trigger launched persona ${trigger.persona} (spawn ${spawnId}, agent ${agentId})`
    );
    return { ran: true, kind: 'spawn' };
  } catch (err) {
    logger.warn(
      `Session-end spawn trigger failed for session ${sessionId}: ${err}`
    );
    return { ran: true, kind: 'spawn', error: String(err) };
  }
}

/**
 * Fire the configured session-end trigger for a finished session. Errors are
 * contained: the hook logs and reports them in the result instead of throwing,
 * so callers can fire it without awaiting (fire-and-forget) safely.
 */
export async function runSessionEndHook(
  sessionId: string
): Promise<SessionEndHookResult> {
  const trigger = hookConfig?.trigger;
  if (!trigger) {
    return { ran: false, kind: 'none' };
  }
  if (trigger.type === 'command') {
    return runCommandTrigger(
      trigger.command,
      hookConfig?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      sessionId
    );
  }
  return runSpawnTrigger(trigger, sessionId);
}
