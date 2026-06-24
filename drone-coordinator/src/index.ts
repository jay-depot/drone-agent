import fastify from "fastify";
import { initDatabase, closeDatabase } from "./db.js";
import { registerRoutes } from "./routes.js";
import { logger } from "./logger.js";

const DEFAULT_PORT = 3456;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_DB_PATH = "./drone-coordinator.db";

interface Config {
  port: number;
  host: string;
  dbPath: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    dbPath: DEFAULT_DB_PATH,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port" && i + 1 < args.length) {
      config.port = parseInt(args[++i], 10);
    } else if (arg === "--host" && i + 1 < args.length) {
      config.host = args[++i];
    } else if (arg === "--db" && i + 1 < args.length) {
      config.dbPath = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
drone-coordinator [options]

Options:
  --port <n>   Port to listen on (default: ${DEFAULT_PORT})
  --host <h>   Host to bind to (default: ${DEFAULT_HOST})
  --db <path>  Path to SQLite database (default: ${DEFAULT_DB_PATH})
  --help       Show this help message
      `);
      process.exit(0);
    }
  }

  return config;
}

async function main() {
  const config = parseArgs();

  logger.info(`Starting drone-coordinator on ${config.host}:${config.port}`);
  logger.info(`Database path: ${config.dbPath}`);

  // Initialize database
  initDatabase(config.dbPath);

  // Create Fastify instance
  const app = fastify({
    logger: logger,
  });

  // Register routes
  await registerRoutes(app);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await app.close();
    closeDatabase();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start server
  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(`Coordinator listening on http://${config.host}:${config.port}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

main();