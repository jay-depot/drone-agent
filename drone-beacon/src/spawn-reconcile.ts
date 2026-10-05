import * as db from './db/index.js';
import { listProcesses, matchPidBySpawnId } from 'drone-swarm-common';
import { getConnectedAgents } from './ws-server.js';
import { logger } from './logger.js';
import type { SpawnRecord } from './types.js';

/**
 * How long a heartbeat keeps a spawn reachable. Covers one 30s heartbeat
 * tick plus jitter.
 */
export const HEARTBEAT_GRACE_MS = 45_000;

/**
 * How long after boot to wait before reconciling, so every live agent has
 * had a chance to re-announce (heartbeat or WebSocket reconnect).
 */
export const RECONCILE_GRACE_MS = 45_000;

export interface SpawnLiveness {
  /** A process with this spawn id is visible to the OS. */
  exists: boolean;
  /** The agent is reachable (socket up, or a recent heartbeat). */
  reachable: boolean;
  live: boolean;
}

/**
 * A spawn is reachable when its agent has an open WebSocket or heartbeated
 * within the grace window. Deliberately independent of the pid check: a
 * wedged process is `exists && !reachable`.
 */
export function isSpawnReachable(
  agentId: string | null,
  lastActivity: number | null,
  connectedAgentIds: ReadonlySet<string>,
  now: number,
  graceMs: number = HEARTBEAT_GRACE_MS
): boolean {
  if (agentId && connectedAgentIds.has(agentId)) return true;
  if (lastActivity !== null && now - lastActivity < graceMs) return true;
  return false;
}

/**
 * Derive liveness for a set of spawns using a single process enumeration.
 * `exists` is false when enumeration is unavailable — the read path reports
 * "not confirmably live" rather than guessing.
 */
export async function getSpawnLiveness(
  spawns: readonly SpawnRecord[]
): Promise<Map<string, SpawnLiveness>> {
  const processes = await listProcesses();
  const now = Date.now();
  const connected = new Set(getConnectedAgents());
  const map = new Map<string, SpawnLiveness>();

  for (const spawn of spawns) {
    const agent = spawn.agentId ? db.getAgent(spawn.agentId) : undefined;
    const reachable = isSpawnReachable(
      spawn.agentId,
      agent ? agent.lastActivity : null,
      connected,
      now
    );
    const exists =
      processes !== null && matchPidBySpawnId(processes, spawn.id) !== null;
    map.set(spawn.id, { exists, reachable, live: exists || reachable });
  }
  return map;
}

/**
 * Downgrade spawn rows that are provably gone after a beacon restart: not
 * reachable (no socket, no recent heartbeat) AND no process carries the
 * spawn id. A row that fails only one signal is left alone. Enumeration
 * failure never downgrades a row — "could not look" is not "absent".
 */
export async function reconcileSpawnRows(
  graceMs: number = HEARTBEAT_GRACE_MS
): Promise<number> {
  const candidates = db
    .listSpawns()
    .filter(spawn => spawn.status === 'running' || spawn.status === 'spawning');
  if (candidates.length === 0) return 0;

  const processes = await listProcesses();
  const now = Date.now();
  const connected = new Set(getConnectedAgents());
  let downgraded = 0;

  for (const spawn of candidates) {
    const agent = spawn.agentId ? db.getAgent(spawn.agentId) : undefined;
    const reachable = isSpawnReachable(
      spawn.agentId,
      agent ? agent.lastActivity : null,
      connected,
      now,
      graceMs
    );
    if (reachable) continue;
    if (processes === null) continue;
    if (matchPidBySpawnId(processes, spawn.id) !== null) continue;

    db.updateSpawnStatus(
      spawn.id,
      'terminated',
      null,
      'process lost across beacon restart'
    );
    if (spawn.agentId) db.unregisterAgent(spawn.agentId);
    downgraded++;
    logger.info(`Reconciled orphaned spawn ${spawn.id}`);
  }
  return downgraded;
}

let reconcileTimer: NodeJS.Timeout | null = null;

/**
 * Schedule the one-shot boot reconcile after a grace window. Boot-only for
 * v1: the grace window is what makes it safe against a slow reconnect.
 */
export function startSpawnReconcile(graceMs: number = RECONCILE_GRACE_MS): void {
  if (reconcileTimer) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcileSpawnRows().catch(err => {
      logger.error(err, 'Spawn reconcile failed');
    });
  }, graceMs);
  reconcileTimer.unref?.();
  logger.info(`Spawn reconcile scheduled in ${graceMs}ms`);
}

export function stopSpawnReconcile(): void {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }
}
