import { randomUUID } from 'node:crypto';
import type { SpawnRequest } from '../types.js';
import { getBeaconUrl } from './context.js';
import * as db from '../db/index.js';
import * as spawner from '../spawner.js';

/**
 * Spawn a new agent. Shared by the REST route and the reverse-channel
 * command handler so both paths behave identically.
 */
export async function handleSpawnAgent(
  req: SpawnRequest
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { personaId, task, config, spawnId } = req;

  if (personaId) {
    const persona = db.getPersona(personaId);
    if (!persona) {
      return {
        status: 400,
        body: { error: `Persona not found: ${personaId}` },
      };
    }
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
    db.createSpawn(finalSpawnId, personaId ?? null, task ?? null, config ?? null);
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

/** Get a single spawn's status. Returns 404 if not found. */
export function handleGetSpawn(spawnId: string): {
  status: number;
  body: unknown;
} {
  const spawn = db.getSpawn(spawnId);
  if (!spawn) {
    return { status: 404, body: { error: 'Spawn not found' } };
  }
  return {
    status: 200,
    body: {
      spawnId: spawn.id,
      agentId: spawn.agentId,
      status: spawn.status,
      createdAt: spawn.createdAt,
      startedAt: spawn.startedAt,
      terminatedAt: spawn.terminatedAt,
      exitCode: spawn.exitCode,
      error: spawn.error,
    },
  };
}

/** Terminate a spawned agent. Returns 404/400 as appropriate. */
export function handleTerminateSpawn(spawnId: string): {
  status: number;
  body: unknown;
} {
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
  const terminated = spawner.terminateAgent(spawnId, false);
  if (!terminated) {
    return {
      status: 400,
      body: { error: 'Failed to terminate agent process' },
    };
  }
  return {
    status: 200,
    body: { success: true, message: 'Termination signal sent' },
  };
}
