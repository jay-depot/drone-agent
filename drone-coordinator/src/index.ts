import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import {
  initDatabase,
  closeDatabase,
  approveBeacon,
  listBeaconTrust,
  listBeacons,
  listAllAgentLocations,
  listSwarmSessions,
} from './db.js';
import { initStorage } from './storage.js';
import { registerRoutes } from './routes/index.js';
import { logger } from './logger.js';
import { loadOrCreateTlsIdentity, getTlsOptions } from './tls.js';
import {
  addSubscriber,
  removeSubscriber,
  subscribeToSession,
  unsubscribeFromSession,
  publishInitialState,
} from './ws-pubsub.js';

const DEFAULT_PORT = 3456;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_CONFIG_DIR = './config';
const DEFAULT_DB_FILENAME = 'drone-coordinator.db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Config {
  port: number;
  host: string;
  configDir: string;
  dbPath: string;
  useHttps: boolean;
  command: 'serve' | 'approve' | 'list-beacons';
  approvalToken?: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    configDir: DEFAULT_CONFIG_DIR,
    dbPath: path.join(DEFAULT_CONFIG_DIR, DEFAULT_DB_FILENAME),
    useHttps: process.env.COORDINATOR_HTTPS === 'true',
    command: 'serve',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' && i + 1 < args.length) {
      config.port = parseInt(args[++i], 10);
    } else if (arg === '--host' && i + 1 < args.length) {
      config.host = args[++i];
    } else if (arg === '--db' && i + 1 < args.length) {
      config.dbPath = args[++i];
    } else if (arg === '--config-dir' && i + 1 < args.length) {
      config.configDir = args[++i];
      config.dbPath = path.join(config.configDir, DEFAULT_DB_FILENAME);
    } else if (arg === '--https') {
      config.useHttps = true;
    } else if (arg === '--no-https') {
      config.useHttps = false;
    } else if (arg === '--approve' && i + 1 < args.length) {
      config.command = 'approve';
      config.approvalToken = args[++i];
    } else if (arg === 'approve') {
      config.command = 'approve';
    } else if (arg === 'list-beacons') {
      config.command = 'list-beacons';
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `\ndrone-coordinator [options]\n\nCommands:\n  serve              Start the coordinator server (default)\n  approve <token>   Approve a pending beacon by token\n  list-beacons       List all registered beacons and their trust status\n\nOptions:\n  --port <n>         Port to listen on (default: ${DEFAULT_PORT})\n  --host <h>         Host to bind to (default: ${DEFAULT_HOST})\n  --config-dir <dir> Configuration directory (default: ${DEFAULT_CONFIG_DIR})\n  --db <path>       Path to SQLite database (default: <config-dir>/${DEFAULT_DB_FILENAME})\n  --https            Enable HTTPS (default: ${process.env.COORDINATOR_HTTPS === 'true' ? 'enabled' : 'disabled'}, or set COORDINATOR_HTTPS=true)\n  --no-https         Disable HTTPS\n  --help             Show this help message\n      `
      );
      process.exit(0);
    }
  }

  return config;
}

async function handleApprove(config: Config) {
  if (!config.approvalToken) {
    console.error('Error: --approve requires a token argument');
    console.log('Usage: drone-coordinator --approve <token>');
    process.exit(1);
  }

  initDatabase(config.dbPath);

  const trust = approveBeacon(config.approvalToken);
  if (!trust) {
    console.error('Error: Invalid or expired approval token');
    closeDatabase();
    process.exit(1);
  }

  console.log(
    `Successfully approved beacon: ${trust.name} (${trust.beaconId})`
  );
  closeDatabase();
  process.exit(0);
}

async function handleListBeacons(config: Config) {
  initDatabase(config.dbPath);

  const trustList = listBeaconTrust();
  const beaconList = listBeacons();

  if (trustList.length === 0 && beaconList.length === 0) {
    console.log('No beacons registered');
    closeDatabase();
    process.exit(0);
  }

  // Merge: trust entries first, then beacons without trust records
  const allBeacons = [
    ...trustList.map(t => ({
      name: t.name,
      beaconId: t.beaconId,
      host: t.host,
      port: t.port,
      status: t.status,
      approvalToken: t.approvalToken,
      approvedAt: t.approvedAt,
    })),
    ...beaconList
      .filter(b => !trustList.some(t => t.beaconId === b.id))
      .map(b => ({
        name: b.name,
        beaconId: b.id,
        host: b.host,
        port: b.port,
        status: 'unknown' as const,
        approvalToken: null,
        approvedAt: null,
      })),
  ];

  console.log('Registered beacons:');
  console.log('------------------');
  for (const beacon of allBeacons) {
    console.log(`${beacon.name} (${beacon.beaconId})`);
    console.log(`  Host: ${beacon.host}:${beacon.port}`);
    console.log(`  Status: ${beacon.status}`);
    if (beacon.status === 'pending' && beacon.approvalToken) {
      console.log(`  Token: ${beacon.approvalToken}`);
    }
    if (beacon.approvedAt) {
      console.log(`  Approved: ${new Date(beacon.approvedAt).toISOString()}`);
    }
    console.log('');
  }

  closeDatabase();
  process.exit(0);
}

function resolveUiDistPath(): string {
  const monorepoPath = path.resolve(
    __dirname,
    '../../drone-coordinator-ui/dist'
  );
  if (existsSync(monorepoPath)) {
    return monorepoPath;
  }
  const nodeModulesPath = path.resolve(
    __dirname,
    '../node_modules/drone-coordinator-ui/dist'
  );
  if (existsSync(nodeModulesPath)) {
    return nodeModulesPath;
  }
  const envPath = process.env.UI_DIST_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  return monorepoPath;
}

async function main() {
  const config = parseArgs();

  if (config.command === 'approve') {
    await handleApprove(config);
    return;
  }

  if (config.command === 'list-beacons') {
    await handleListBeacons(config);
    return;
  }

  const protocol = config.useHttps ? 'https' : 'http';
  logger.info(`Starting drone-coordinator on ${config.host}:${config.port}`);
  logger.info(`Configuration directory: ${config.configDir}`);
  logger.info(`Database path: ${config.dbPath}`);
  logger.info(`Protocol: ${protocol.toUpperCase()}`);

  initDatabase(config.dbPath);
  initStorage(config.configDir);

  let tlsOptions: { cert: Buffer; key: Buffer } | undefined;
  if (config.useHttps) {
    const tlsIdentity = loadOrCreateTlsIdentity(config.configDir);
    tlsOptions = getTlsOptions(tlsIdentity);
    logger.info(`TLS certificate fingerprint: ${tlsIdentity.fingerprint}`);
  }

  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    ...(config.useHttps && tlsOptions
      ? { https: { allowHTTP1: true, ...tlsOptions } }
      : {}),
  });

  await app.register(fastifyCors, {
    origin: process.env.NODE_ENV === 'development' ? true : false,
  });

  await app.register(import('@fastify/websocket'));

  // WebSocket endpoint for real-time events
  app.get('/ws', { websocket: true }, (socket, req) => {
    const sub = addSubscriber(socket);

    try {
      const beacons = listBeacons();
      const agentLocations = listAllAgentLocations();
      const swarmSessions = listSwarmSessions('active');
      const sessions = swarmSessions.map(s => {
        const beacon = beacons.find(b => b.id === s.beaconId);
        return {
          id: s.id,
          beaconId: s.beaconId,
          agentId: s.id,
          personaId: s.personaId,
          connectedAt: s.createdAt,
          disconnectedAt: null,
          durationMs: null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          beaconName: beacon?.name ?? s.beaconId,
          beaconHost: beacon?.host,
          beaconPort: beacon?.port,
        };
      });

      publishInitialState(socket, {
        beacons,
        agentLocations,
        sessions,
      });
    } catch (err) {
      logger.warn(`Failed to build initial state: ${err}`);
    }

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe' && msg.sessionId) {
          subscribeToSession(sub, msg.sessionId);
        } else if (msg.type === 'unsubscribe' && msg.sessionId) {
          unsubscribeFromSession(sub, msg.sessionId);
        }
      } catch {
        // Ignore malformed messages
      }
    });

    const interval = setInterval(() => {
      try {
        socket.send(JSON.stringify({ type: 'ping' }));
      } catch {
        clearInterval(interval);
      }
    }, 30000);

    socket.on('close', () => {
      clearInterval(interval);
      removeSubscriber(sub);
    });
  });

  // Register API routes (must be registered BEFORE @fastify/static)
  await registerRoutes(app);

  // Serve the UI static files — only under /assets/
  const uiDistPath = resolveUiDistPath();
  logger.info(`Serving UI from: ${uiDistPath}`);

  await app.register(fastifyStatic, {
    root: path.join(uiDistPath, 'assets'),
    prefix: '/assets/',
    wildcard: false,
  });

  // Serve the root index.html
  app.get('/', async (request, reply) => {
    return reply.sendFile('index.html', path.resolve(uiDistPath));
  });

  // SPA fallback
  app.setNotFoundHandler(async (request, reply) => {
    if (
      request.url.startsWith('/api') ||
      request.url.startsWith('/ws') ||
      request.url.startsWith('/health')
    ) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html', path.resolve(uiDistPath));
  });

  const shutdown = async () => {
    logger.info('Shutting down...');
    await app.close();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await app.listen({
      port: config.port,
      host: config.host,
    });
    logger.info(
      `Coordinator listening on ${protocol}://${config.host}:${config.port}`
    );
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();
