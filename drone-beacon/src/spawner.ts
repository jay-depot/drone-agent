/**
 * Thin wrapper around drone-swarm-common's spawner.
 *
 * Provides the SpawnDb adapter that bridges to the beacon's SQLite database,
 * and re-exports the shared spawner's public API with beacon-specific types.
 */
import {
  initSpawner as sharedInitSpawner,
  getSpawnerConfig as sharedGetSpawnerConfig,
  spawnAgent as sharedSpawnAgent,
  terminateAgent as sharedTerminateAgent,
  getActiveSpawns as sharedGetActiveSpawns,
  getManagedProcess as sharedGetManagedProcess,
  cleanupAllSpawns as sharedCleanupAllSpawns,
  type SpawnerConfig,
  type ManagedProcess,
  type SpawnDb,
} from 'drone-swarm-common';
import * as db from './db/index.js';
import type { SpawnConfig, SpawnRecord } from './types.js';

// === SpawnDb adapter: bridges the shared spawner to beacon's SQLite db ===

const beaconSpawnDb: SpawnDb = {
  createSpawn(
    spawnId: string,
    personaId: string | null,
    task: string | null,
    config: Record<string, unknown> | null
  ): SpawnRecord {
    return db.createSpawn(
      spawnId,
      personaId,
      task,
      config as SpawnConfig | null
    );
  },

  updateSpawnStatus(
    id: string,
    status: string,
    agentId?: string | null,
    error?: string,
    exitCode?: number
  ): SpawnRecord | undefined {
    return db.updateSpawnStatus(
      id,
      status as SpawnRecord['status'],
      agentId,
      error,
      exitCode
    );
  },

  getSpawn(id: string): { status: string } | undefined {
    return db.getSpawn(id);
  },
};

// === Re-exported API (same signatures as before) ===

export { SpawnerConfig, ManagedProcess };

export function initSpawner(cfg: SpawnerConfig): void {
  sharedInitSpawner(cfg, beaconSpawnDb);
}

export function getSpawnerConfig(): SpawnerConfig | null {
  return sharedGetSpawnerConfig();
}

export async function spawnAgent(
  spawnId: string,
  agentId: string,
  personaId: string | null,
  task: string | null,
  configOverride?: SpawnConfig
): Promise<SpawnRecord> {
  return sharedSpawnAgent(
    spawnId,
    agentId,
    personaId,
    task,
    configOverride as Record<string, unknown> | undefined
  ) as Promise<SpawnRecord>;
}

export function terminateAgent(
  spawnId: string,
  force: boolean = false
): boolean {
  return sharedTerminateAgent(spawnId, force);
}

export function getActiveSpawns(): string[] {
  return sharedGetActiveSpawns();
}

export function getManagedProcess(spawnId: string): ManagedProcess | undefined {
  return sharedGetManagedProcess(spawnId);
}

export function cleanupAllSpawns(): void {
  sharedCleanupAllSpawns();
}
