import { spawn } from 'node:child_process';
import type { SessionEndTrigger } from 'drone-swarm-common';
import { logger } from './logger.js';
import * as db from './db/index.js';
import { isBeaconConnected, sendBeaconCommand } from './beacon-ws.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const ESCALATION_KILL_GRACE_MS = 200;
const FALLBACK_SETTLE_GRACE_MS = 1000;

export interface SessionEndHookConfig {
  trigger?: SessionEndTrigger;
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
  // The coordinator has no local spawner; a spawn trigger must name the
  // beacon that will run the agent. This is validated at startup.
  const beaconId = trigger.beaconId as string;
  const beacon = db.getBeacon(beaconId);
  if (!beacon) {
    return {
      ran: false,
      kind: 'spawn',
      error: `beacon not found: ${beaconId}`,
    };
  }
  const payload = {
    personaId: trigger.persona,
    task: `Session ${sessionId} ended (session-end trigger)`,
  };

  // Preferred path: push the spawn down the beacon's reverse-channel
  // WebSocket (the beacon opens it toward the coordinator at startup), so
  // the coordinator never needs an inbound HTTP connection to the beacon.
  if (isBeaconConnected(beaconId)) {
    try {
      const res = await sendBeaconCommand(beaconId, 'spawn', payload, 10000);
      if (!res.ok) {
        logger.warn(
          `Session-end spawn to beacon ${beaconId} failed over reverse channel for session ${sessionId}: ${res.status} ${JSON.stringify(res.body)}`
        );
        return { ran: true, kind: 'spawn', error: `status ${res.status}` };
      }
      logger.info(
        `Session-end spawn trigger forwarded persona ${trigger.persona} to beacon ${beaconId} via reverse channel`
      );
      return { ran: true, kind: 'spawn' };
    } catch (err) {
      logger.warn(
        `Reverse-channel spawn to beacon ${beaconId} failed for session ${sessionId}: ${err}; falling back to HTTP`
      );
    }
  }

  // Fallback: direct HTTP to the beacon's /spawn route for beacons that
  // have not (yet) connected their reverse channel.
  try {
    const response = await fetch(`http://${beacon.host}:${beacon.port}/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const details = await response.text();
      logger.warn(
        `Session-end spawn to beacon ${beaconId} failed for session ${sessionId}: ${response.status} ${details}`
      );
      return { ran: true, kind: 'spawn', error: `status ${response.status}` };
    }
    logger.info(
      `Session-end spawn trigger forwarded persona ${trigger.persona} to beacon ${beaconId}`
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
