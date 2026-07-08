import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from './logger.js';
import { GatewayEngine } from './engine.js';
import { LocalSpawnBackend } from './local-spawn-backend.js';
import { CoordinatorSpawnBackend } from './coordinator-spawn-backend.js';
import { loadGatewayConfig } from './config/load.js';
import type { GatewayConfig, SpawnBackendType } from './types.js';
import type { SpawnBackend } from './spawn-backend.js';

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.drone-gateway');
const DEFAULT_CONFIG_FILE = 'config.json';

interface CliConfig {
  configPath: string;
  command: 'serve';
}

export function parseArgs(): CliConfig {
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
      console.log(
        `\ndrone-gateway [options]\n\nOptions:\n  --config <path>  Path to config file (default: ~/.drone-gateway/config.json)\n  --help           Show this help message\n      `
      );
      process.exit(0);
    }
  }

  return cliConfig;
}

/**
 * Load and validate the gateway configuration from the folder hierarchy.
 * Delegates to the async folder-based loader in config/load.ts.
 */
export async function loadConfig(configPath: string): Promise<GatewayConfig> {
  if (!existsSync(configPath)) {
    logger.error(`Config file not found: ${configPath}`);
    console.error(
      `Error: Config file not found: ${configPath}\n` +
        `Create a config file at this path or use --config to specify one.\n` +
        `See the drone-gateway documentation for config format.`
    );
    process.exit(1);
  }

  const config = await loadGatewayConfig(configPath);

  // Apply defaults
  if (!config.spawnBackend) {
    config.spawnBackend = 'local' as SpawnBackendType;
  }

  return config;
}

export function createSpawnBackend(config: GatewayConfig): SpawnBackend {
  switch (config.spawnBackend) {
    case 'local':
      logger.info(
        `Using local spawn backend (agentPath: ${config.agentPath || 'drone-agent (from PATH)'})`
      );
      return new LocalSpawnBackend(config.agentPath);
    case 'coordinator':
      logger.info('Using coordinator spawn backend');
      return new CoordinatorSpawnBackend(
        config.coordinatorUrl,
        config.coordinatorToken
      );
    default:
      logger.error(`Unknown spawn backend type: ${config.spawnBackend}`);
      process.exit(1);
  }
}

export async function main(): Promise<void> {
  const cliConfig = parseArgs();

  logger.info(`Loading config from: ${cliConfig.configPath}`);
  const config = await loadConfig(cliConfig.configPath);

  const spawnBackend = createSpawnBackend(config);
  const engine = new GatewayEngine(config, spawnBackend);

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
