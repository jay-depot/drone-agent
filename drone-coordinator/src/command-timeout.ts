import type { SessionEndTrigger } from 'drone-swarm-common';

export const DEFAULT_COMMAND_TIMEOUT_MS = 300000;

/**
 * Timeout for the session-end command trigger: the config-supplied
 * `commandTimeoutMs` wins when present; otherwise the default.
 */
export function resolveSessionEndCommandTimeoutMs(
  sessionEnd: SessionEndTrigger
): number {
  return sessionEnd.type === 'command' &&
    sessionEnd.commandTimeoutMs !== undefined
    ? sessionEnd.commandTimeoutMs
    : DEFAULT_COMMAND_TIMEOUT_MS;
}
