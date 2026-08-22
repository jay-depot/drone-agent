import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SessionEndTrigger } from 'drone-swarm-common';
import { logger } from './logger.js';
import { spawnAgent } from './spawner.js';

const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

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
  const finalCommand = substituteSessionId(command, sessionId);
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', finalCommand], {
      timeout: timeoutMs,
    });
    let settled = false;
    const settle = (result: SessionEndHookResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
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
        `Session-end command timed out after ${timeoutMs}ms for session ${sessionId}`
      );
    });
    child.on('close', code => {
      if (code === 0) {
        logger.info(`Session-end command completed for session ${sessionId}`);
        settle({ ran: true, kind: 'command' });
      } else {
        logger.warn(
          `Session-end command exited with code ${code} for session ${sessionId}`
        );
        settle({
          ran: true,
          kind: 'command',
          error: `exit code ${code}`,
        });
      }
    });
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
