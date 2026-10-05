import { randomUUID } from 'node:crypto';
import type { SpawnRequest } from '../types.js';
import { getBeaconUrl } from './context.js';
import * as db from '../db/index.js';
import * as spawner from '../spawner.js';
import { isAgentConnected, sendToAgent } from '../ws-server.js';
import { getSpawnLiveness } from '../spawn-reconcile.js';
import {
  getDefaultSpawnRoot,
  getSpawnRoots,
  isSpawnRootAllowed,
} from '../spawn-roots.js';

/**
 * Spawn a new agent. Shared by the REST route and the reverse-channel
 * command handler so both paths behave identically.
 */
export async function handleSpawnAgent(
  req: SpawnRequest
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { personaId, task, spawnId } = req;
  let config = req.config;

  if (personaId) {
    const persona = db.getPersona(personaId);
    if (!persona) {
      return {
        status: 400,
        body: { error: `Persona not found: ${personaId}` },
      };
    }
  }

  // Enforce the spawnRoots whitelist (advertise == enforce by construction).
  // A provided workingDir must be within the expanded root set; when omitted,
  // default to the beacon's configured default root.
  const workingDir = config?.workingDir;
  if (workingDir) {
    if (!isSpawnRootAllowed(workingDir)) {
      return {
        status: 400,
        body: {
          error: `workingDir "${workingDir}" is not in the spawnRoots whitelist`,
          allowedRoots: getSpawnRoots(),
        },
      };
    }
  } else if (getDefaultSpawnRoot()) {
    config = { ...config, workingDir: getDefaultSpawnRoot() };
  }

  const finalSpawnId = spawnId || randomUUID();
  const agentId = `agent-${randomUUID()}`;

  try {
    const spawnRecord = await spawner.spawnAgent(
      finalSpawnId,
      agentId,
      personaId ?? null,
      task ?? null,
      config
    );
    return {
      status: 202,
      body: {
        spawnId: spawnRecord.id,
        agentId,
        status: spawnRecord.status,
        beaconUrl: getBeaconUrl(),
        message: 'Agent spawned, waiting for connection',
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    db.createSpawn(
      finalSpawnId,
      personaId ?? null,
      task ?? null,
      config ?? null
    );
    db.updateSpawnStatus(finalSpawnId, 'failed', null, message);
    return {
      status: 202,
      body: {
        spawnId: finalSpawnId,
        agentId,
        status: 'failed',
        beaconUrl: getBeaconUrl(),
        message,
      },
    };
  }
}

/** List spawns, optionally filtered by status. */
export function handleListSpawns(status?: string) {
  return db.listSpawns(status);
}

/**
 * Get a single spawn's status. Returns 404 if not found. The derived `live`
 * field reports whether the agent is confirmably alive (process visible or
 * reachable); it is a view, not a stored state.
 */
export async function handleGetSpawn(spawnId: string): Promise<{
  status: number;
  body: unknown;
}> {
  const spawn = db.getSpawn(spawnId);
  if (!spawn) {
    return { status: 404, body: { error: 'Spawn not found' } };
  }
  const liveness = (await getSpawnLiveness([spawn])).get(spawn.id);
  return {
    status: 200,
    body: {
      spawnId: spawn.id,
      agentId: spawn.agentId,
      status: spawn.status,
      live: liveness?.live ?? false,
      createdAt: spawn.createdAt,
      startedAt: spawn.startedAt,
      terminatedAt: spawn.terminatedAt,
      exitCode: spawn.exitCode,
      error: spawn.error,
    },
  };
}

export interface TerminateTiming {
  /** How long to wait for an in-process exit before signalling (stage 1). */
  stage1GraceMs?: number;
  /** How long to wait after SIGTERM before SIGKILL (stage 2 -> 3). */
  stage2GraceMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_STAGE1_GRACE_MS = 5000;
const DEFAULT_STAGE2_GRACE_MS = 5000;
const DEFAULT_POLL_INTERVAL_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH: already gone. Nothing to signal.
  }
}

async function waitForAgentDisconnect(
  agentId: string,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAgentConnected(agentId)) return true;
    await sleep(pollIntervalMs);
  }
  return !isAgentConnected(agentId);
}

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(pollIntervalMs);
  }
  return !isPidAlive(pid);
}

/**
 * Terminate a spawned agent with a three-stage ladder:
 *   1. ask the agent to exit in-process over its WebSocket (graceful; works
 *      where SIGTERM is not catchable),
 *   2. SIGTERM the pid found by argv lookup,
 *   3. SIGKILL the same pid.
 *
 * A pid is only ever signalled when enumeration positively found it. When
 * enumeration is unavailable and the agent is unreachable, the request fails
 * (409) rather than risk killing the wrong process.
 */
export async function handleTerminateSpawn(
  spawnId: string,
  timing: TerminateTiming = {}
): Promise<{ status: number; body: unknown }> {
  const stage1GraceMs = timing.stage1GraceMs ?? DEFAULT_STAGE1_GRACE_MS;
  const stage2GraceMs = timing.stage2GraceMs ?? DEFAULT_STAGE2_GRACE_MS;
  const pollIntervalMs = timing.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const spawn = db.getSpawn(spawnId);
  if (!spawn) {
    return { status: 404, body: { error: 'Spawn not found' } };
  }
  if (spawn.status !== 'running' && spawn.status !== 'spawning') {
    return {
      status: 400,
      body: { error: `Cannot terminate: agent status is ${spawn.status}` },
    };
  }

  const agentId = spawn.agentId;

  if (agentId && isAgentConnected(agentId)) {
    sendToAgent(agentId, { type: 'shutdown' });
    if (await waitForAgentDisconnect(agentId, stage1GraceMs, pollIntervalMs)) {
      db.updateSpawnStatus(spawnId, 'terminated');
      return {
        status: 200,
        body: { success: true, message: 'Agent shut down gracefully' },
      };
    }
  }

  const lookup = await spawner.findPidBySpawnId(spawnId);
  if (lookup.status === 'found') {
    signalProcess(lookup.pid, 'SIGTERM');
    if (await waitForPidExit(lookup.pid, stage2GraceMs, pollIntervalMs)) {
      db.updateSpawnStatus(spawnId, 'terminated');
      return {
        status: 200,
        body: { success: true, message: 'Termination signal sent' },
      };
    }
    signalProcess(lookup.pid, 'SIGKILL');
    db.updateSpawnStatus(spawnId, 'terminated');
    return {
      status: 200,
      body: { success: true, message: 'Force-killed unresponsive agent' },
    };
  }

  if (lookup.status === 'unavailable') {
    return {
      status: 409,
      body: {
        error:
          'Cannot terminate: process enumeration is unavailable and the agent is unreachable',
      },
    };
  }

  if (agentId && isAgentConnected(agentId)) {
    return {
      status: 409,
      body: {
        error:
          'Cannot terminate: agent process not found but the session is still connected',
      },
    };
  }

  db.updateSpawnStatus(
    spawnId,
    'terminated',
    null,
    'process lost across beacon restart'
  );
  return {
    status: 409,
    body: { error: 'Agent process is no longer running' },
  };
}
