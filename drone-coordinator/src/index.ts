import fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import '@fastify/websocket';
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
  getWebToken,
  generateWebToken,
  initWebToken,
} from './db.js';
import { initStorage } from './storage.js';
import { registerRoutes } from './routes/index.js';
import { logger } from './logger.js';
import { loadOrCreateTlsIdentity, getTlsOptions, setTlsLogger } from 'drone-swarm-common/tls';
import {
  addSubscriber,
  removeSubscriber,
  subscribeToSession,
  unsubscribeFromSession,
  publishInitialState,
} from './ws-pubsub.js';
import { createWebAuthMiddleware } from './web-auth.js';

const DEFAULT_PORT = 3456;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_WEB_PORT = 8080;
const DEFAULT_WEB_HOST = '127.0.0.1';
const DEFAULT_CONFIG_DIR = './config';
const DEFAULT_DB_FILENAME = 'drone-coordinator.db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface Config {
  port: number;
  host: string;
  webPort: number;
  webHost: string;
  configDir: string;
  dbPath: string;
  useHttps: boolean;
  command:
    | 'serve'
    | 'approve'
    | 'list-beacons'
    | 'show-web-token'
    | 'generate-web-token';
  approvalToken?: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    webPort: DEFAULT_WEB_PORT,
    webHost: DEFAULT_WEB_HOST,
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
    } else if (arg === '--web-port' && i + 1 < args.length) {
      config.webPort = parseInt(args[++i], 10);
    } else if (arg === '--web-host' && i + 1 < args.length) {
      config.webHost = args[++i];
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
    } else if (arg === '--show-web-token') {
      config.command = 'show-web-token';
    } else if (arg === '--generate-web-token') {
      config.command = 'generate-web-token';
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `\ndrone-coordinator [options]\n\nCommands:\n  serve              Start the coordinator server (default)\n  approve <token>   Approve a pending beacon by token\n  list-beacons       List all registered beacons and their trust status\n  --show-web-token   Print the current web UI access token\n  --generate-web-token Generate a new web UI access token\n\nOptions:\n  --port <n>         Port to listen on (default: ${DEFAULT_PORT})\n  --host <h>         Host to bind to (default: ${DEFAULT_HOST})\n  --web-port <n>     HTTP port for web UI (default: ${DEFAULT_WEB_PORT})\n  --web-host <h>     Host for web UI port (default: ${DEFAULT_WEB_HOST})\n  --config-dir <dir> Configuration directory (default: ${DEFAULT_CONFIG_DIR})\n  --db <path>       Path to SQLite database (default: <config-dir>/${DEFAULT_DB_FILENAME})\n  --https            Enable HTTPS (default: ${process.env.COORDINATOR_HTTPS === 'true' ? 'enabled' : 'disabled'}, or set COORDINATOR_HTTPS=true)\n  --no-https         Disable HTTPS\n  --help             Show this help message\n      `
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

async function handleShowWebToken(config: Config) {
  initDatabase(config.dbPath);
  const token = getWebToken();
  if (!token) {
    console.log('No web token found. Generating one...');
    const newToken = generateWebToken();
    console.log(newToken);
  } else {
    console.log(token);
  }
  closeDatabase();
  process.exit(0);
}

async function handleGenerateWebToken(config: Config) {
  initDatabase(config.dbPath);
  const token = generateWebToken();
  console.log(token);
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

/**
 * Set up a Fastify instance with all routes, WebSocket, static files, and SPA fallback.
 * Optionally registers auth middleware if a token provider is given.
 */
async function setupServer(
  app: FastifyInstance,
  uiDistPath: string,
  opts?: { getToken?: () => string | null }
) {
  await app.register(fastifyCors, {
    origin: process.env.NODE_ENV === 'development' ? true : false,
  });

  // Register auth middleware for the web port
  if (opts?.getToken) {
    app.addHook('onRequest', createWebAuthMiddleware(opts.getToken));
  }

  await app.register(import('@fastify/websocket'));

  // WebSocket endpoint for real-time events
  app.get('/ws', { websocket: true }, (socket, req) => {
    // For web port: also check token from query parameter
    // (WebSocket upgrade requests can't easily set custom headers from browser)
    if (opts?.getToken) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const queryToken = url.searchParams.get('token');
      const token = opts.getToken();
      if (token && queryToken !== token) {
        // Token required but not provided or invalid via query param.
        // The onRequest hook already checked the Authorization header,
        // so if we got here without a valid header, check query param.
        // If neither is valid, close the connection.
        const authHeader = req.headers.authorization;
        const headerToken = authHeader?.startsWith('Bearer ')
          ? authHeader.slice(7)
          : null;
        if (headerToken !== token && queryToken !== token) {
          socket.close(4001, 'Unauthorized');
          return;
        }
      }
    }

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

  if (config.command === 'show-web-token') {
    await handleShowWebToken(config);
    return;
  }

  if (config.command === 'generate-web-token') {
    await handleGenerateWebToken(config);
    return;
  }

  const protocol = config.useHttps ? 'https' : 'http';
  logger.info(`Starting drone-coordinator on ${config.host}:${config.port}`);
  logger.info(`Web UI on ${config.webHost}:${config.webPort} (HTTP)`);
  logger.info(`Configuration directory: ${config.configDir}`);
  logger.info(`Database path: ${config.dbPath}`);
  logger.info(`Protocol: ${protocol.toUpperCase()}`);

  initDatabase(config.dbPath);
  initStorage(config.configDir);

  // Initialize web token (auto-generates on first startup)
  initWebToken();

  // Set TLS logger
  setTlsLogger(logger);

  let tlsOptions: { cert: Buffer; key: Buffer } | undefined;
  if (config.useHttps) {
    const tlsIdentity = loadOrCreateTlsIdentity(config.configDir, 'coordinator');
    tlsOptions = getTlsOptions(tlsIdentity);
    logger.info(`TLS certificate fingerprint: ${tlsIdentity.fingerprint}`);
  }

  const uiDistPath = resolveUiDistPath();
  logger.info(`Serving UI from: ${uiDistPath}`);

  // Primary server (with TLS if configured)
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    ...(config.useHttps && tlsOptions
      ? { https: { allowHTTP1: true, ...tlsOptions } }
      : {}),
  });

  await setupServer(app, uiDistPath);

  // Web server (HTTP only, no TLS, with auth for non-local connections)
  const webApp = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  await setupServer(webApp, uiDistPath, { getToken: () => getWebToken() });

  const shutdown = async () => {
    logger.info('Shutting down...');
    await Promise.all([app.close(), webApp.close()]);
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await Promise.all([
      app.listen({
        port: config.port,
        host: config.host,
      }),
      webApp.listen({
        port: config.webPort,
        host: config.webHost,
      }),
    ]);
    logger.info(
      `Coordinator listening on ${protocol}://${config.host}:${config.port}`
    );
    logger.info(
      `Web UI listening on http://${config.webHost}:${config.webPort}`
    );
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();
