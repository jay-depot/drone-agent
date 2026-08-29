import * as db from './db/index.js';
import {
  pushFragmentToAgent,
  isAgentConnected,
} from './ws-server.js';
import { logger } from './logger.js';
import { TTL_SWEEP_INTERVAL_MS } from './fragments-limits.js';

let sweepInterval: NodeJS.Timeout | null = null;

/**
 * Periodically delete expired targeted fragments. For every deleted row
 * whose target is a connected agent, push a remove-op so the agent's prompt
 * stops rendering it without a reconnect.
 */
function sweepExpiredFragments(): void {
  const deleted = db.deleteExpiredFragments();
  for (const fragment of deleted) {
    if (isAgentConnected(fragment.target)) {
      pushFragmentToAgent(fragment.target, 'remove', fragment);
      logger.info(
        `Pushed expired-fragment removal to ${fragment.target}: ${fragment.id}`
      );
    }
  }
}

export function startFragmentTtlSweep(): void {
  if (sweepInterval) return;
  sweepInterval = setInterval(sweepExpiredFragments, TTL_SWEEP_INTERVAL_MS);
  logger.info('Fragment TTL sweep scheduled');
}

export function stopFragmentTtlSweep(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
    logger.info('Fragment TTL sweep stopped');
  }
}