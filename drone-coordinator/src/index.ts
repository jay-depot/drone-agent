import fastify from 'fastify';
import path from 'path';
import { initDatabase, closeDatabase } from './db.js';
import { registerRoutes } from './routes.js';
import { logger } from './logger.js';

const DEFAULT_PORT = 3456;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_CONFIG_DIR = './config';
const DEFAULT_DB_FILENAME = 'drone-coordinator.db';

interface Config {
  port: number;
  host: string;
  configDir: string;
  dbPath: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    configDir: DEFAULT_CONFIG_DIR,
    dbPath: path.join(DEFAULT_CONFIG_DIR, DEFAULT_DB_FILENAME),
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
      // Update dbPath to be relative to the new config dir
      config.dbPath = path.join(config.configDir, DEFAULT_DB_FILENAME);
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
drone-coordinator [options]

Options:
  --port <n>       Port to listen on (default: ${DEFAULT_PORT})
  --host <h>       Host to bind to (default: ${DEFAULT_HOST})
  --config-dir <dir>  Configuration directory (default: ${DEFAULT_CONFIG_DIR})
  --db <path>     Path to SQLite database (default: <config-dir>/${DEFAULT_DB_FILENAME})
  --help          Show this help message
      `);
      process.exit(0);
    }
  }

  return config;
}

async function main() {
  const config = parseArgs();

  logger.info(`Starting drone-coordinator on ${config.host}:${config.port}`);
  logger.info(`Configuration directory: ${config.configDir}`);
  logger.info(`Database path: ${config.dbPath}`);

  // Initialize database
  initDatabase(config.dbPath);

  // Create Fastify instance with built-in logger (simpler for Docker)
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
    await app.listen({ port: config.port, host: config.host });
    logger.info(
      `Coordinator listening on http://${config.host}:${config.port}`
    );
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();
