import { readFileSync, existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logger.js';
import { convIdToFilename, validateConversationId } from './files.js';
import type {
  GatewayConfig,
  ResolvedServiceAdapter,
  ControlSurfaceSpec,
  SpawnBackendType,
} from '../types.js';

/**
 * Load and validate the full gateway configuration from a folder hierarchy.
 *
 * Layout:
 *   <configDir>/
 *     config.json              # gateway-level settings
 *     adapters/
 *       <adapterId>/
 *         adapter.json         # adapter settings + conversations inline (legacy)
 *         conversations/
 *           <convId>.json      # one file per conversation
 *           _default_.json     # wildcard catch-all (convId = "*")
 *
 * The `configPath` argument points to the gateway config.json file.
 * The adapters/ directory is expected alongside it.
 */
export async function loadGatewayConfig(configPath: string): Promise<GatewayConfig> {
  const configDir = path.dirname(configPath);

  if (!existsSync(configPath)) {
    logger.error(`Config file not found: ${configPath}`);
    throw new Error(
      `Config file not found: ${configPath}\n` +
        `Create a config file at this path or use --config to specify one.\n` +
        `See the drone-gateway documentation for config format.`
    );
  }

  // Read gateway-level config
  const raw = readFileSync(configPath, 'utf-8');
  let gatewayConfig: Record<string, unknown>;
  try {
    gatewayConfig = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in config file: ${err}`);
  }

  // Validate required fields
  if (!gatewayConfig.coordinatorUrl || typeof gatewayConfig.coordinatorUrl !== 'string') {
    throw new Error('Config missing required field: coordinatorUrl');
  }

  // Apply defaults
  const spawnBackend: SpawnBackendType =
    (gatewayConfig.spawnBackend as SpawnBackendType) || 'local';

  // Build the base config
  const config: GatewayConfig = {
    coordinatorUrl: gatewayConfig.coordinatorUrl as string,
    coordinatorToken: gatewayConfig.coordinatorToken as string | undefined,
    spawnBackend,
    agentPath: gatewayConfig.agentPath as string | undefined,
    serviceAdapters: [],
  };

  // Load adapters from the adapters/ directory
  const adaptersDir = path.join(configDir, 'adapters');
  if (!existsSync(adaptersDir)) {
    logger.warn(`No adapters/ directory found at ${adaptersDir}`);
    return config;
  }

  const adapterDirs = await readdir(adaptersDir, { withFileTypes: true });
  const adapterIds = adapterDirs
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  for (const adapterId of adapterIds) {
    const adapter = await loadAdapter(adaptersDir, adapterId);
    if (adapter) {
      config.serviceAdapters.push(adapter);
    }
  }

  return config;
}

async function loadAdapter(
  adaptersDir: string,
  adapterId: string
): Promise<ResolvedServiceAdapter | null> {
  const adapterDir = path.join(adaptersDir, adapterId);
  const adapterJsonPath = path.join(adapterDir, 'adapter.json');

  if (!existsSync(adapterJsonPath)) {
    logger.warn(`Skipping adapter "${adapterId}": no adapter.json found`);
    return null;
  }

  let adapterData: Record<string, unknown>;
  try {
    const raw = readFileSync(adapterJsonPath, 'utf-8');
    adapterData = JSON.parse(raw);
  } catch (err) {
    logger.error(
      { adapterId, err },
      `Failed to parse adapter.json for "${adapterId}"`
    );
    return null;
  }

  const type = adapterData.type as string | undefined;
  if (!type || typeof type !== 'string') {
    logger.error({ adapterId }, `Adapter "${adapterId}" missing required field: type`);
    return null;
  }

  // Build config (everything except id and type)
  const { type: _type, ...restConfig } = adapterData;

  // Load conversations
  const conversations = new Map<string, ControlSurfaceSpec[]>();
  const convDir = path.join(adapterDir, 'conversations');

  if (existsSync(convDir)) {
    const convFiles = await readdir(convDir);
    for (const file of convFiles) {
      if (!file.endsWith('.json')) continue;

      const filePath = path.join(convDir, file);
      let convData: Record<string, unknown>;
      try {
        const raw = readFileSync(filePath, 'utf-8');
        convData = JSON.parse(raw);
      } catch (err) {
        logger.warn(
          { adapterId, file, err },
          `Failed to parse conversation file "${file}"`
        );
        continue;
      }

      // Read canonical conversationId from the file (not the filename)
      const convId = convData.conversationId as string | undefined;
      if (!convId || typeof convId !== 'string') {
        logger.warn(
          { adapterId, file },
          `Conversation file "${file}" missing or invalid conversationId field`
        );
        continue;
      }

      // Validate
      const validationError = validateConversationId(convId);
      if (validationError) {
        logger.warn(
          { adapterId, file, convId, validationError },
          `Invalid conversationId in "${file}"`
        );
        continue;
      }

      // Read control surfaces
      const rawSurfaces = convData.controlSurfaces as unknown[];
      if (!Array.isArray(rawSurfaces) || rawSurfaces.length === 0) {
        logger.warn(
          { adapterId, file, convId },
          `Conversation "${convId}" has no controlSurfaces array`
        );
        continue;
      }

      const specs: ControlSurfaceSpec[] = [];
      for (const raw of rawSurfaces) {
        const spec = raw as Record<string, unknown>;
        if (!spec.type || typeof spec.type !== 'string') {
          logger.warn(
            { adapterId, file, convId },
            `Control surface in "${file}" missing type field`
          );
          continue;
        }
        specs.push({
          type: spec.type as string,
          personaId: spec.personaId as string | undefined,
          config: spec.config as Record<string, unknown> | undefined,
        });
      }

      if (specs.length > 0) {
        conversations.set(convId, specs);
      }
    }
  }

  return {
    id: adapterId,
    type,
    config: restConfig as Record<string, unknown>,
    conversations,
  };
}
