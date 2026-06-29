import fastify from 'fastify';
import path from 'path';
import {
  initDatabase,
  closeDatabase,
  approveBeacon,
  listBeaconTrust,
} from './db.js';
import { initStorage } from './storage.js';
import { registerRoutes } from './routes/index.js';
import { logger } from './logger.js';
import { loadOrCreateTlsIdentity, getTlsOptions } from './tls.js';

const DEFAULT_PORT = 3456;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_CONFIG_DIR = './config';
const DEFAULT_DB_FILENAME = 'drone-coordinator.db';

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
      console.log(`
drone-coordinator [options]

Commands:
  serve              Start the coordinator server (default)
  approve <token>   Approve a pending beacon by token
  list-beacons       List all registered beacons and their trust status

Options:
  --port <n>         Port to listen on (default: ${DEFAULT_PORT})
  --host <h>         Host to bind to (default: ${DEFAULT_HOST})
  --config-dir <dir> Configuration directory (default: ${DEFAULT_CONFIG_DIR})
  --db <path>       Path to SQLite database (default: <config-dir>/${DEFAULT_DB_FILENAME})
  --https            Enable HTTPS (default: ${process.env.COORDINATOR_HTTPS === 'true' ? 'enabled' : 'disabled'}, or set COORDINATOR_HTTPS=true)
  --no-https         Disable HTTPS
  --help             Show this help message
      `);
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

  const beacons = listBeaconTrust();
  if (beacons.length === 0) {
    console.log('No beacons registered');
    closeDatabase();
    process.exit(0);
  }

  console.log('Registered beacons:');
  console.log('------------------');
  for (const beacon of beacons) {
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

  // Initialize database
  initDatabase(config.dbPath);

  // Initialize storage engine for large payloads
  initStorage(config.configDir);

  // Create Fastify instance
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // Register routes
  await registerRoutes(app);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await app.close();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  try {
    const listenOptions: {
      port: number;
      host: string;
      cert?: Buffer;
      key?: Buffer;
    } = {
      port: config.port,
      host: config.host,
    };

    if (config.useHttps) {
      const tlsIdentity = loadOrCreateTlsIdentity(config.configDir);
      const tlsOptions = getTlsOptions(tlsIdentity);
      listenOptions.cert = tlsOptions.cert;
      listenOptions.key = tlsOptions.key;
      logger.info(`TLS certificate fingerprint: ${tlsIdentity.fingerprint}`);
    }

    await app.listen(listenOptions);
    logger.info(
      `Coordinator listening on ${protocol}://${config.host}:${config.port}`
    );
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();
