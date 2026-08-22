  --config-file <path>         Load settings from a JSON config file (flags override file values)
import fastify from 'fastify';
import '@fastify/websocket';
import {
  createOllamaEmbeddingProvider,
  loadConfigFile,
  mergeConfig,
  type ServerConfigFile,
  type SessionEndTrigger,
} from 'drone-swarm-common';
import { SearchIndexer } from './search-indexer.js';
import os from 'node:os';
import path from 'path';
import fs from 'fs';
import {
  initDatabase,
  closeDatabase,
  cleanupExpiredMemories,
  backfillVecChunks,
} from './db/index.js';
import {
  registerRoutes,
  setCoordinatorClient,
  setBeaconAddress,
  triggerCoordinatorSync,
  setSearchIndexer,
} from './routes/index.js';
import {
  createCoordinatorClient,
  type CoordinatorClient,
  type CoordinatorClientOptions,
  setOutboxEnabled,
} from './coordinator-client.js';
import { createOutboxFlusher } from './outbox-flusher.js';
import { resolveDroneExecutable } from 'drone-core';
import {
  initCoordinatorTrust,
  setPendingCoordinatorFingerprint,
  getTrustedCoordinatorFingerprint,
  confirmCoordinatorFingerprint,
  setBeaconApproved,
} from './coordinator-trust.js';
import {
  initSpawner,
  cleanupAllSpawns,
  type SpawnerConfig,
} from './spawner.js';
import * as wsServer from './ws-server.js';
import { logger } from './logger.js';
import { loadOrCreateIdentity } from './identity.js';
import { configureSessionEndHook } from './session-end.js';
import {
  loadOrCreateTlsIdentity,
  getTlsOptions,
  setTlsLogger,
} from 'drone-swarm-common/tls';
import { setKnowledgeBaseDir } from 'drone-swarm-common/wiki-storage';

const DEFAULT_PORT = 3457;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.drone-beacon');
const DEFAULT_DB_FILENAME = 'drone-beacon.db';
const DEFAULT_SPAWN_AGENT_PATH = 'drone-agent';
const DEFAULT_SPAWN_TIMEOUT_MS = 30000;
const DEFAULT_MAX_CONCURRENT_SPAWNS = 10;
const DEFAULT_SYNC_INTERVAL_MINUTES = 5;
const DEFAULT_COMMAND_TIMEOUT_MS = 30000;

interface Config {
  port: number;
  host: string;
  configDir: string;
  dbPath: string;
  command: 'serve' | 'confirm-coordinator-fingerprint';
  confirmFingerprint?: string;
  coordinatorHost?: string;
  coordinatorPort?: number;
  coordinatorUseHttps: boolean;
  beaconId: string;
  beaconName: string;
  useHttps: boolean;
  spawnAgentPath: string;
  spawnTimeoutMs: number;
  maxConcurrentSpawns: number;
  syncIntervalMinutes: number;
  sessionEnd?: SessionEndTrigger;
}

async function parseArgs(): Promise<Config> {
  const args = process.argv.slice(2);
  let fileConfig: ServerConfigFile | undefined;
  const flagOverrides: { port?: number; host?: string; dbPath?: string } = {};
  const config: Config = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    configDir: DEFAULT_CONFIG_DIR,
    dbPath: path.join(DEFAULT_CONFIG_DIR, DEFAULT_DB_FILENAME),
    beaconId: `beacon-${Date.now()}`,
    beaconName: 'default-beacon',
    spawnAgentPath: DEFAULT_SPAWN_AGENT_PATH,
    spawnTimeoutMs: DEFAULT_SPAWN_TIMEOUT_MS,
    maxConcurrentSpawns: DEFAULT_MAX_CONCURRENT_SPAWNS,
    syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
    coordinatorUseHttps: process.env.COORDINATOR_HTTPS === 'true',
    useHttps: process.env.BEACON_HTTPS === 'true',
    command: 'serve',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && i + 1 < args.length) {
      config.port = parseInt(args[++i], 10);
      flagOverrides.port = config.port;
    } else if (arg === '--config-file' && i + 1 < args.length) {
      const filePath = args[++i];
      try {
        fileConfig = await loadConfigFile(filePath);
      } catch (err) {
        console.error(String(err));
        process.exit(1);
      }
    } else if (arg === '--host' && i + 1 < args.length) {
      config.host = args[++i];
      flagOverrides.host = config.host;
    } else if (arg === '--db' && i + 1 < args.length) {
      config.dbPath = args[++i];
      flagOverrides.dbPath = config.dbPath;
    } else if (arg === '--config-dir' && i + 1 < args.length) {
      config.configDir = args[++i];
      config.dbPath = path.join(config.configDir, DEFAULT_DB_FILENAME);
      flagOverrides.dbPath = config.dbPath;
    } else if (arg === '--coordinator-host' && i + 1 < args.length) {
      config.coordinatorHost = args[++i];
    } else if (arg === '--coordinator-port' && i + 1 < args.length) {
      config.coordinatorPort = parseInt(args[++i], 10);
    } else if (arg === '--coordinator-https') {
      config.coordinatorUseHttps = true;
    } else if (arg === '--id' && i + 1 < args.length) {
      config.beaconId = args[++i];
    } else if (arg === '--name' && i + 1 < args.length) {
      config.beaconName = args[++i];
    } else if (arg === '--https') {
      config.useHttps = true;
    } else if (arg === '--no-https') {
      config.useHttps = false;
    } else if (arg === '--spawn-agent-path' && i + 1 < args.length) {
      config.spawnAgentPath = args[++i];
    } else if (arg === '--spawn-timeout-ms' && i + 1 < args.length) {
      config.spawnTimeoutMs = parseInt(args[++i], 10);
    } else if (arg === '--max-concurrent-spawns' && i + 1 < args.length) {
      config.maxConcurrentSpawns = parseInt(args[++i], 10);
    } else if (arg === '--sync-interval-minutes' && i + 1 < args.length) {
      config.syncIntervalMinutes = parseInt(args[++i], 10);
    } else if (
      arg === '--confirm-coordinator-fingerprint' &&
      i + 1 < args.length
    ) {
      config.command = 'confirm-coordinator-fingerprint';
      config.confirmFingerprint = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `\ndrone-beacon [options]\n\nOptions:\n  --port <n>                   Port to listen on (default: ${DEFAULT_PORT})\n  --host <h>                   Host to bind to (default: ${DEFAULT_HOST})\n  --config-dir <dir>           Configuration directory (default: ${DEFAULT_CONFIG_DIR})\n  --db <path>                  Path to SQLite database (default: <config-dir>/${DEFAULT_DB_FILENAME})\n  --coordinator-host <h>       Host of the coordinator to connect to\n  --coordinator-port <n>       Port of the coordinator (default: ${DEFAULT_PORT + 1})\n  --coordinator-https          Use HTTPS for coordinator connection\n  --confirm-coordinator-fingerprint <fp>  Confirm the coordinator TLS fingerprint (TOFU)\n  --id <id>                    Beacon ID (auto-generated by default)\n  --name <name>                Beacon name (default: default-beacon)\n  --https                      Enable HTTPS server\n  --no-https                   Disable HTTPS server (default)\n  --spawn-agent-path <path>    Path to drone-agent binary (default: ${DEFAULT_SPAWN_AGENT_PATH})\n  --spawn-timeout-ms <n>       Timeout for agent to connect (default: ${DEFAULT_SPAWN_TIMEOUT_MS})\n  --max-concurrent-spawns <n>  Max concurrent spawned agents (default: ${DEFAULT_MAX_CONCURRENT_SPAWNS})\n  --sync-interval-minutes <n>  Interval for periodic coordinator sync (default: ${DEFAULT_SYNC_INTERVAL_MINUTES})\n  --help                       Show this help message\n      `
      );
      process.exit(0);
    }
  }

  if (fileConfig) {
    const merged = mergeConfig<ServerConfigFile>(
      fileConfig,
      flagOverrides
    );
    config.port = (merged.port as number) ?? config.port;
    config.host = (merged.host as string) ?? config.host;
    config.dbPath = (merged.dbPath as string) ?? config.dbPath;
    if (merged.sessionEnd !== undefined) {
      config.sessionEnd = merged.sessionEnd as SessionEndTrigger;
    }
  }

  if (config.coordinatorHost && !config.coordinatorPort) {
    config.coordinatorPort = DEFAULT_PORT + 1;
  }

  return config;
}

async function main() {
  const config = await parseArgs();

  if (config.command === 'confirm-coordinator-fingerprint') {
    if (!config.confirmFingerprint) {
      console.error(
        'Error: --confirm-coordinator-fingerprint requires a fingerprint argument'
      );
      console.log('Usage: drone-beacon --confirm-coordinator-fingerprint <fp>');
      process.exit(1);
    }
    initCoordinatorTrust(config.configDir);
    const ok = confirmCoordinatorFingerprint(config.confirmFingerprint);
    if (!ok) {
      process.exit(1);
    }
    process.exit(0);
  }

  if (config.sessionEnd) {
    configureSessionEndHook({
      trigger: config.sessionEnd,
      beaconId: config.beaconId,
      commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    });
    logger.info('Session-end hook configured');
  }

  const beaconProtocol = config.useHttps ? 'https' : 'http';
  const coordinatorProtocol = config.coordinatorUseHttps ? 'https' : 'http';

  logger.info(`Starting drone-beacon on ${config.host}:${config.port}`);
  logger.info(`Configuration directory: ${config.configDir}`);
  logger.info(`Database path: ${config.dbPath}`);
  logger.info(`Beacon protocol: ${beaconProtocol.toUpperCase()}`);
  logger.info(`Coordinator protocol: ${coordinatorProtocol.toUpperCase()}`);

  // Ensure config directory exists
  fs.mkdirSync(config.configDir, { recursive: true });

  // Initialize database
  initDatabase(config.dbPath);
  const backfilled = backfillVecChunks();
  if (backfilled > 0) {
    logger.info(`Search index: backfilled ${backfilled} chunk(s) into vec0`);
  }
  // Initialize search indexer
  const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  let searchIndexer: SearchIndexer;
  try {
    const provider = createOllamaEmbeddingProvider({ host: ollamaHost });
    searchIndexer = new SearchIndexer(provider);
    logger.info(
      `Search indexer initialized with Ollama embedding provider (${ollamaHost})`
    );
  } catch (err) {
    searchIndexer = new SearchIndexer();
    logger.warn(
      `Search indexer initialized without embedding provider: ${err}`
    );
  }
  setSearchIndexer(searchIndexer);
  searchIndexer.startPeriodicSweep();

  // Initialize wiki storage under config dir
  setKnowledgeBaseDir(path.join(config.configDir, 'knowledge-base'));

  // Load or create beacon identity (Ed25519 keypair)
  const identity = await loadOrCreateIdentity(
    config.beaconId,
    config.configDir
  );
  logger.info(
    `Beacon identity loaded (public key: ${identity.publicKeyHex.slice(0, 16)}...)`
  );

  // Set TLS logger
  setTlsLogger(logger);

  // Load or create TLS certificate
  const tlsIdentity = await loadOrCreateTlsIdentity(config.configDir);
  logger.info(`TLS certificate fingerprint: ${tlsIdentity.fingerprint}`);

  // Initialize spawner
  const resolvedSpawnAgentPath = await resolveDroneExecutable({
    commandName: config.spawnAgentPath,
  });

  const spawnerConfig: SpawnerConfig = {
    agentPath: resolvedSpawnAgentPath,
    timeoutMs: config.spawnTimeoutMs,
    maxConcurrentSpawns: config.maxConcurrentSpawns,
    beaconHost: config.host === '0.0.0.0' ? 'localhost' : config.host,
    beaconPort: config.port,
  };
  initSpawner(spawnerConfig);
  logger.info(
    `Spawner configured: path=${resolvedSpawnAgentPath}, timeout=${config.spawnTimeoutMs}ms, max=${config.maxConcurrentSpawns}`
  );

  // Set beacon address for routes
  setBeaconAddress(
    config.host === '0.0.0.0' ? 'localhost' : config.host,
    config.port
  );

  // Set up coordinator client if configured
  let coordinatorClient: CoordinatorClient | undefined;
  if (config.coordinatorHost && config.coordinatorPort) {
    initCoordinatorTrust(config.configDir);
    const coordinatorTlsFingerprint = getTrustedCoordinatorFingerprint();

    const coordinatorClientOptions: CoordinatorClientOptions = {
      identity,
      tlsIdentity,
      useHttps: config.coordinatorUseHttps,
      coordinatorTlsFingerprint,
      onFirstCoordinatorFingerprint: fp => {
        setPendingCoordinatorFingerprint(fp);
      },
    };

    coordinatorClient = createCoordinatorClient(
      {
        host: config.coordinatorHost,
        port: config.coordinatorPort,
        beaconId: config.beaconId,
        beaconName: config.beaconName,
      },
      coordinatorClientOptions
    );

    setCoordinatorClient(coordinatorClient);

    try {
      const result = await coordinatorClient.registerBeacon(
        identity,
        tlsIdentity.fingerprint
      );

      if (result.status === 'approved') {
        setBeaconApproved(true);
      }

      if (result.status === 'pending') {
        logger.info('Beacon pending approval.');
        logger.info(
          'Approve via the coordinator web UI (beacon detail page) or: drone-coordinator --approve-beacon <id>'
        );

        // Remind the operator periodically until approved
        const reminder = setInterval(() => {
          logger.info(
            '[REMINDER] Beacon still pending approval. Approve via the coordinator web UI (beacon detail page) or: drone-coordinator --approve-beacon <id>'
          );
        }, 60000);

        // Poll for approval
        const pollInterval = setInterval(async () => {
          try {
            const status = await coordinatorClient!.pollForApproval();
            if (status.status === 'approved') {
              logger.info('Beacon approved!');
              setBeaconApproved(true);
              clearInterval(reminder);
              clearInterval(pollInterval);
            } else if (status.status === 'rejected') {
              logger.error('Beacon rejected by coordinator');
              setBeaconApproved(false);
              clearInterval(reminder);
              clearInterval(pollInterval);
            }
          } catch (err) {
            logger.warn(`Polling error: ${err}`);
          }
        }, 30000);
      }
    } catch (err) {
      logger.warn(
        `Failed to register with coordinator: ${err}. Running in offline mode.`
      );
    }
  }

  // Create Fastify instance
  // For HTTPS, pass the cert/key in the constructor's https property.
  // Fastify's https option creates an HTTP/2 secure server when allowHTTP1
  // is set, and the TLS options must be provided here (not in listen()).
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    ...(config.useHttps
      ? { https: { allowHTTP1: true, ...getTlsOptions(tlsIdentity) } }
      : {}),
  });

  // Register routes
  await registerRoutes(app);

  // Register WebSocket server with local-only enforcement
  await wsServer.registerWebSocketServer(app, { enforceLocalOnly: true });
  wsServer.startMessageCleanup();

  // Start periodic TTL cleanup
  const cleanupInterval = setInterval(() => {
    try {
      cleanupExpiredMemories();
    } catch (err) {
      logger.error(err, 'TTL cleanup failed');
    }
  }, 60000);

  // Start periodic coordinator sync if configured
  let syncInterval: NodeJS.Timeout | undefined;
  let outboxFlusher: ReturnType<typeof createOutboxFlusher> | undefined;
  if (coordinatorClient) {
    const syncIntervalMs = config.syncIntervalMinutes * 60 * 1000;
    logger.info(
      `Starting periodic coordinator sync every ${config.syncIntervalMinutes} minutes`
    );

    try {
      await triggerCoordinatorSync();
    } catch (err) {
      logger.warn(`Initial sync failed: ${err}`);
    }

    syncInterval = setInterval(async () => {
      try {
        await triggerCoordinatorSync();
      } catch (err) {
        logger.warn(`Periodic sync failed: ${err}`);
      }
    }, syncIntervalMs);
  }

  if (coordinatorClient) {
    setOutboxEnabled(true);
    outboxFlusher = createOutboxFlusher({
      getBaseUrl: () => coordinatorClient?.getBaseUrl(),
      intervalMs: Math.min(syncIntervalMs, 60000),
    });
    outboxFlusher.start();
    logger.info('Outbox flusher started');
  }

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    clearInterval(cleanupInterval);
    searchIndexer.stopPeriodicSweep();
    if (syncInterval) {
      clearInterval(syncInterval);
    }
    outboxFlusher?.stop();

    cleanupAllSpawns();
    await app.close();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  try {
    await app.listen({
      port: config.port,
      host: config.host,
    });
    logger.info(
      `Beacon listening on ${beaconProtocol}://${config.host}:${config.port}`
    );
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();
