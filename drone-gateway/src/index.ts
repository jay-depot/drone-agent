import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from './logger.js';
import { GatewayEngine } from './engine.js';
import type { GatewayConfig } from './types.js';

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.drone-gateway');
const DEFAULT_CONFIG_FILE = 'config.json';

interface CliConfig {
  configPath: string;
  command: 'serve';
}

function parseArgs(): CliConfig {
  const args = process.argv.slice(2);
  const cliConfig: CliConfig = {
    configPath: path.join(DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE),
    command: 'serve',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && i + 1 < args.length) {
      cliConfig.configPath = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
drone-gateway [options]

Options:
  --config <path>  Path to config file (default: ~/.drone-gateway/config.json)
  --help           Show this help message
      `);
      process.exit(0);
    }
  }

  return cliConfig;
}

function loadConfig(configPath: string): GatewayConfig {
  if (!existsSync(configPath)) {
    logger.error(`Config file not found: ${configPath}`);
    console.error(
      `Error: Config file not found: ${configPath}\n` +
        `Create a config file at this path or use --config to specify one.\n` +
        `See the drone-gateway documentation for config format.`
    );
    process.exit(1);
  }

  const raw = readFileSync(configPath, 'utf-8');
  const config: GatewayConfig = JSON.parse(raw);

  // Basic validation
  if (!config.coordinatorUrl) {
    logger.error('Config missing required field: coordinatorUrl');
    process.exit(1);
  }

  if (!Array.isArray(config.serviceAdapters)) {
    logger.error('Config missing required field: serviceAdapters');
    process.exit(1);
  }

  return config;
}

export async function main(): Promise<void> {
  const cliConfig = parseArgs();

  logger.info(`Loading config from: ${cliConfig.configPath}`);
  const config = loadConfig(cliConfig.configPath);

  const engine = new GatewayEngine(config);

  const shutdown = async () => {
    logger.info('Shutting down...');
    await engine.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await engine.start();
    logger.info('Gateway started successfully');
    // Keep running until SIGINT/SIGTERM
    await new Promise(() => {}); // never resolves
  } catch (err) {
    logger.error(err, 'Failed to start gateway');
    await engine.stop();
    process.exit(1);
  }
}

// Entry guard
const invokedDirectly =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  void main();
}
