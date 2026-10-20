import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { redeemPreApprovalToken } from 'drone-swarm-common';
import { logger } from './logger.js';
import { GatewayEngine } from './engine.js';
import { LocalSpawnBackend } from './local-spawn-backend.js';
import { CoordinatorSpawnBackend } from './coordinator-spawn-backend.js';
import { CoordinatorClient } from './coordinator-client.js';
import { ExtensionNodeHandle } from './extension-node.js';
import { loadGatewayConfig } from './config/load.js';
import { cleanupAdapter } from './cleanup.js';
import { ControlApiServer } from './control-api/server.js';
import type { GatewayConfig } from './types.js';
import { SpawnBackendRegistry } from './spawn-backend-registry.js';

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.drone-gateway');
const DEFAULT_CONFIG_FILE = 'config.json';

interface CliConfig {
  configPath: string;
  command: 'serve' | 'cleanup';
  cleanupAdapterId?: string;
  preApprovalTokenPath?: string;
}

export function parseArgs(): CliConfig {
  const args = process.argv.slice(2);
  const cliConfig: CliConfig = {
    configPath: path.join(DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE),
    command: 'serve',
  };

  const tokenFlag = '--pre-approval-token-path';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--config' && i + 1 < args.length) {
      cliConfig.configPath = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        `\ndrone-gateway [command] [options]\n\n` +
          `Commands:\n` +
          `  serve                          Start the gateway (default)\n` +
          `  cleanup --adapter <id>         Decommission an adapter (logout + delete dataPath)\n\n` +
          `Options:\n` +
          `  --config <path>  Path to config file (default: ~/.drone-gateway/config.json)\n` +
          `  --adapter <id>   Adapter ID to clean up (for cleanup command)\n` +
          `  --pre-approval-token-path <path>  Redeem a pre-approval token, then exit\n` +
          `  --help           Show this help message\n`
      );
      process.exit(0);
    } else if (arg === 'cleanup') {
      cliConfig.command = 'cleanup';
    } else if (arg === '--adapter' && i + 1 < args.length) {
      cliConfig.cleanupAdapterId = args[++i];
    } else if (arg === tokenFlag && i + 1 < args.length) {
      cliConfig.preApprovalTokenPath = args[++i];
    } else if (arg.startsWith(`${tokenFlag}=`)) {
      cliConfig.preApprovalTokenPath = arg.slice(tokenFlag.length + 1);
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

  return config;
}

/**
 * Build the spawn-backend registry: a local backend always, and a coordinator
 * backend whenever a coordinator client is available. The engine picks the
 * backend per control surface.
 */
export function createSpawnBackends(
  config: GatewayConfig,
  coordinatorClient?: CoordinatorClient
): SpawnBackendRegistry {
  const registry = new SpawnBackendRegistry();
  registry.register('local', new LocalSpawnBackend(config.agentPath));
  logger.info(
    `Registered local spawn backend (agentPath: ${config.agentPath || 'drone-agent (from PATH)'})`
  );
  if (coordinatorClient) {
    registry.register(
      'coordinator',
      new CoordinatorSpawnBackend(coordinatorClient)
    );
    logger.info(
      `Registered coordinator spawn backend (${config.coordinatorUrl})`
    );
  }
  return registry;
}

async function readGatewayVersion(): Promise<string> {
  try {
    const raw = await readFile(
      new URL('../package.json', import.meta.url),
      'utf-8'
    );
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function main(): Promise<void> {
  const cliConfig = parseArgs();

  if (cliConfig.command === 'cleanup') {
    if (!cliConfig.cleanupAdapterId) {
      console.error(
        'Error: cleanup command requires --adapter <id>\n' +
          'Usage: drone-gateway cleanup --adapter <adapter-id>'
      );
      process.exit(1);
    }

    const configDir = path.dirname(cliConfig.configPath);
    await cleanupAdapter(configDir, cliConfig.cleanupAdapterId);
    return;
  }

  // Default: serve command
  logger.info(`Loading config from: ${cliConfig.configPath}`);
  const config = await loadConfig(cliConfig.configPath);

  if (cliConfig.preApprovalTokenPath) {
    if (!config.swarmExtension) {
      console.error(
        'Error: --pre-approval-token-path requires a coordinatorUrl in the config'
      );
      process.exit(1);
    }
    try {
      await redeemPreApprovalToken({
        coordinatorUrl: config.coordinatorUrl,
        dataDir: config.swarmExtension.dataDir,
        id: config.swarmExtension.id,
        name: config.swarmExtension.name,
        tokenPath: cliConfig.preApprovalTokenPath,
      });
    } catch (err) {
      console.error(
        `Pre-approval failed: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
    console.log('Pre-approval complete. Exiting.');
    return;
  }

  // `coordinatorUrl` presence is the extension gate (D4): with a coordinator the
  // gateway is a swarm extension and the node's mTLS fetch carries all
  // coordinator traffic; without one it is a standalone chat agent runner.
  const nodeHandle = config.swarmExtension
    ? new ExtensionNodeHandle(config.coordinatorUrl, config.swarmExtension)
    : undefined;
  const coordinatorClient = nodeHandle
    ? new CoordinatorClient(
        nodeHandle.fetch.bind(nodeHandle),
        config.coordinatorUrl
      )
    : undefined;
  const backends = createSpawnBackends(config, coordinatorClient);
  const engine = new GatewayEngine(config, backends, coordinatorClient);

  let controlApi: ControlApiServer | undefined;

  const shutdown = async () => {
    logger.info('Shutting down...');
    await controlApi?.stop();
    // Agents terminate over the LIVE node, so the node stops last (D13).
    await engine.stop();
    await nodeHandle?.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await engine.start();
    // Not awaited: the gateway serves conversations before the coordinator
    // answers, and the node retries registration in the background (D8).
    nodeHandle?.start();

    if (config.controlApi?.enabled) {
      controlApi = new ControlApiServer({
        engine,
        config: config.controlApi,
        version: await readGatewayVersion(),
      });
      await controlApi.start();
    }

    logger.info('Gateway started successfully');
    // Keep running until SIGINT/SIGTERM
    await new Promise(() => {}); // never resolves
  } catch (err) {
    logger.error(err, 'Failed to start gateway');
    await controlApi?.stop();
    await engine.stop();
    await nodeHandle?.stop();
    process.exit(1);
  }
}
