import { spawn, type ChildProcess } from 'child_process';
import * as db from './db.js';
import { logger } from './logger.js';
import type { SpawnConfig, SpawnRecord } from './types.js';

export interface SpawnerConfig {
  agentPath: string;
  timeoutMs: number;
  maxConcurrentSpawns: number;
  beaconHost: string;
  beaconPort: number;
}

interface ManagedProcess {
  spawnId: string;
  process: ChildProcess;
  startedAt: number;
}

// Track spawned processes
const activeSpawns = new Map<string, ManagedProcess>();
let config: SpawnerConfig | null = null;

export function initSpawner(cfg: SpawnerConfig): void {
  config = cfg;
  logger.info(
    `Spawner initialized: agentPath=${cfg.agentPath}, maxConcurrent=${cfg.maxConcurrentSpawns}`
  );
}

export function getSpawnerConfig(): SpawnerConfig | null {
  return config;
}

// Get count of active (non-terminated) spawns
function getActiveSpawnCount(): number {
  return activeSpawns.size;
}

export async function spawnAgent(
  spawnId: string,
  agentId: string,
  personaId: string | null,
  task: string | null,
  configOverride?: SpawnConfig
): Promise<SpawnRecord> {
  if (!config) {
    throw new Error('Spawner not initialized. Call initSpawner() first.');
  }

  // Check max concurrent spawns
  if (getActiveSpawnCount() >= config.maxConcurrentSpawns) {
    throw new Error('Max concurrent spawns reached');
  }

  // Build command arguments
  const args: string[] = [
    '--swarm',
    '--session-id',
    agentId,
    '--beacon-host',
    config.beaconHost,
    '--beacon-port',
    String(config.beaconPort),
  ];

  if (personaId) {
    args.push('--persona', personaId);
  }

  if (task) {
    args.push('--task', task);
  }

  // Add config overrides
  if (configOverride) {
    if (configOverride.model) {
      args.push('--model', configOverride.model);
    }
    if (configOverride.workingDir) {
      args.push('--working-dir', configOverride.workingDir);
    }
  }

  logger.info(`Spawning agent: ${agentId} with args: ${args.join(' ')}`);

  // Create spawn record in database
  const spawnRecord = db.createSpawn(
    spawnId,
    personaId,
    task,
    configOverride ?? null
  );

  // Spawn the process
  const childProcess = spawn(config.agentPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(configOverride?.env || {}),
    },
    cwd: configOverride?.workingDir || process.cwd(),
  });

  // Track the process
  activeSpawns.set(spawnId, {
    spawnId,
    process: childProcess,
    startedAt: Date.now(),
  });

  // Handle process events
  childProcess.on('exit', (code, signal) => {
    logger.info(`Agent ${agentId} exited with code=${code}, signal=${signal}`);

    // Update spawn record
    db.updateSpawnStatus(
      spawnId,
      'terminated',
      null,
      undefined,
      code ?? undefined
    );

    // Clean up tracking
    activeSpawns.delete(spawnId);
  });

  childProcess.on('error', err => {
    logger.error(`Agent ${agentId} error: ${err.message}`);

    // Update spawn record with error
    db.updateSpawnStatus(spawnId, 'failed', null, err.message);

    // Clean up tracking
    activeSpawns.delete(spawnId);
  });

  // Log stdout/stderr
  if (childProcess.stdout) {
    childProcess.stdout.on('data', data => {
      logger.debug(`[${agentId}] stdout: ${data.toString().trim()}`);
    });
  }

  if (childProcess.stderr) {
    childProcess.stderr.on('data', data => {
      logger.debug(`[${agentId}] stderr: ${data.toString().trim()}`);
    });
  }

  // Set up timeout to mark as failed if agent doesn't connect
  setTimeout(() => {
    const managed = activeSpawns.get(spawnId);
    if (managed) {
      const spawn = db.getSpawn(spawnId);
      if (spawn && spawn.status === 'spawning') {
        logger.warn(`Agent ${agentId} did not connect within timeout`);
        db.updateSpawnStatus(spawnId, 'failed', null, 'timeout');
        // Don't kill the process - let it run, but mark as failed
      }
    }
  }, config.timeoutMs);

  // Return spawn record (status: spawning)
  return spawnRecord;
}

export function terminateAgent(
  spawnId: string,
  force: boolean = false
): boolean {
  const managed = activeSpawns.get(spawnId);
  if (!managed) {
    logger.warn(`No active spawn found for ${spawnId}`);
    return false;
  }

  const { process, spawnId: sid } = managed;
  logger.info(`Terminating agent: ${sid}, force=${force}`);

  if (force) {
    process.kill('SIGKILL');
  } else {
    process.kill('SIGTERM');
    // Set a timeout to send SIGKILL if it doesn't exit
    setTimeout(() => {
      const stillActive = activeSpawns.get(spawnId);
      if (stillActive && stillActive.process && !stillActive.process.killed) {
        logger.warn(
          `Agent ${sid} did not terminate gracefully, sending SIGKILL`
        );
        stillActive.process.kill('SIGKILL');
      }
    }, 5000);
  }

  return true;
}

export function getActiveSpawns(): string[] {
  return Array.from(activeSpawns.keys());
}

export function getManagedProcess(spawnId: string): ManagedProcess | undefined {
  return activeSpawns.get(spawnId);
}

// Cleanup on shutdown - terminate all spawned agents
export function cleanupAllSpawns(): void {
  logger.info(`Cleaning up ${activeSpawns.size} active spawns`);
  for (const [spawnId, managed] of activeSpawns) {
    logger.info(`Terminating spawn: ${spawnId}`);
    managed.process.kill('SIGTERM');
  }
  activeSpawns.clear();
}
