import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from './logger.js';

// === Types ===

export interface SpawnerConfig {
  agentPath: string;
  timeoutMs: number;
  maxConcurrentSpawns: number;
  beaconHost: string;
  beaconPort: number;
}

export interface ManagedProcess {
  spawnId: string;
  process: ChildProcess;
  startedAt: number;
}

/**
 * Database-agnostic interface for spawn record operations.
 * Implementations provide the actual storage (SQLite, in-memory, etc.).
 */
export interface SpawnDb {
  createSpawn(
    spawnId: string,
    personaId: string | null,
    task: string | null,
    config: Record<string, unknown> | null
  ): unknown;
  updateSpawnStatus(
    id: string,
    status: string,
    agentId?: string | null,
    error?: string,
    exitCode?: number
  ): unknown;
  getSpawn(id: string): { status: string } | undefined;
}

// === State ===

const activeSpawns = new Map<string, ManagedProcess>();
let spawnerConfig: SpawnerConfig | null = null;
let spawnDb: SpawnDb | null = null;
const MAX_WORKING_DIR_LENGTH = 4096;

// === Initialization ===

export function initSpawner(cfg: SpawnerConfig, db: SpawnDb): void {
  spawnerConfig = cfg;
  spawnDb = db;
  logger.info(
    `Spawner initialized: agentPath=${cfg.agentPath}, maxConcurrent=${cfg.maxConcurrentSpawns}`
  );
}

export function getSpawnerConfig(): SpawnerConfig | null {
  return spawnerConfig;
}

// === Core Operations ===

function getActiveSpawnCount(): number {
  return activeSpawns.size;
}

export async function spawnAgent(
  spawnId: string,
  agentId: string,
  personaId: string | null,
  task: string | null,
  configOverride?: Record<string, unknown>
): Promise<unknown> {
  if (!spawnerConfig) {
    throw new Error('Spawner not initialized. Call initSpawner() first.');
  }
  if (!spawnDb) {
    throw new Error('Spawner not initialized. Call initSpawner() first.');
  }

  const workingDirOverride = (configOverride as { workingDir?: string })
    ?.workingDir;
  const workingDir = workingDirOverride || process.cwd();
  if (workingDir.length > MAX_WORKING_DIR_LENGTH) {
    throw new Error(
      `Working directory exceeds maximum length: ${workingDir.length}`
    );
  }

  // Check max concurrent spawns
  if (getActiveSpawnCount() >= spawnerConfig.maxConcurrentSpawns) {
    throw new Error('Max concurrent spawns reached');
  }

  // Build command arguments
  const args: string[] = [
    '--swarm',
    '--session-id',
    agentId,
    '--beacon-host',
    spawnerConfig.beaconHost,
    '--beacon-port',
    String(spawnerConfig.beaconPort),
  ];

  if (personaId) {
    args.push('--persona', personaId);
  }

  if (task) {
    args.push('--task', task);
  }

  // Add config overrides
  if (configOverride) {
    const cfg = configOverride as Record<string, unknown>;
    if (cfg.model) {
      args.push('--model', String(cfg.model));
    }
    if (workingDirOverride) {
      args.push('--working-dir', workingDirOverride);
    }
  }

  logger.info(`Spawning agent: ${agentId} with args: ${args.join(' ')}`);

  // Create spawn record in database
  const spawnRecord = spawnDb.createSpawn(
    spawnId,
    personaId,
    task,
    configOverride ?? null
  );

  // Spawn the process
  const childProcess = spawn(spawnerConfig.agentPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...((configOverride as { env?: Record<string, string> })?.env || {}),
    },
    cwd: workingDir,
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
    spawnDb!.updateSpawnStatus(
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
    spawnDb!.updateSpawnStatus(spawnId, 'failed', null, err.message);

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
      const spawn = spawnDb!.getSpawn(spawnId);
      if (spawn && spawn.status === 'spawning') {
        logger.warn(`Agent ${agentId} did not connect within timeout`);
        spawnDb!.updateSpawnStatus(spawnId, 'failed', null, 'timeout');
        // Don't kill the process - let it run, but mark as failed
      }
    }
  }, spawnerConfig.timeoutMs);

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

  const { process } = managed;
  logger.info(`Terminating agent: ${spawnId}, force=${force}`);

  if (force) {
    process.kill('SIGKILL');
  } else {
    process.kill('SIGTERM');
    // Set a timeout to send SIGKILL if it doesn't exit
    setTimeout(() => {
      const stillActive = activeSpawns.get(spawnId);
      if (stillActive && stillActive.process && !stillActive.process.killed) {
        logger.warn(
          `Agent ${spawnId} did not terminate gracefully, sending SIGKILL`
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
