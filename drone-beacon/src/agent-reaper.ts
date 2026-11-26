import * as db from './db/index.js';
import { getConnectedAgents } from './ws-server.js';
import { isSpawnReachable, HEARTBEAT_GRACE_MS } from './spawn-reconcile.js';
import { removeAgent } from './agent-removal.js';
import { logger } from './logger.js';

/** How often the beacon sweeps the agent table. */
export const AGENT_REAP_INTERVAL_MS = 60_000;

/**
 * Delete every agent row that is neither socket-connected nor recently
 * heartbeated. Return the deleted agent ids. The reachability rule is shared
 * with the boot spawn reconcile, so the two views cannot drift.
 */
export async function reapStaleAgents(
  now: number = Date.now(),
  connectedAgentIds: ReadonlySet<string> = new Set(getConnectedAgents()),
  graceMs: number = HEARTBEAT_GRACE_MS
): Promise<string[]> {
  const reaped: string[] = [];
  for (const agent of db.listAgents()) {
    const reachable = isSpawnReachable(
      agent.id,
      agent.lastActivity,
      connectedAgentIds,
      now,
      graceMs
    );
    if (reachable) continue;
    const result = await removeAgent(agent.id);
    if (result.removed) {
      reaped.push(agent.id);
      logger.info(`Reaped stale agent ${agent.id}`);
    }
  }
  return reaped;
}

let reapTimer: NodeJS.Timeout | null = null;

/** Start the periodic reap sweep. Idempotent. */
export function startAgentReaper(
  intervalMs: number = AGENT_REAP_INTERVAL_MS
): NodeJS.Timeout {
  if (reapTimer) return reapTimer;
  reapTimer = setInterval(() => {
    void reapStaleAgents().catch(err => {
      logger.error(err, 'Agent reaper failed');
    });
  }, intervalMs);
  reapTimer.unref?.();
  logger.info(`Agent reaper scheduled every ${intervalMs}ms`);
  return reapTimer;
}

export function stopAgentReaper(): void {
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
}
