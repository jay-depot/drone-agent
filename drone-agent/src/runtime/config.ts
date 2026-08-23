import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  validateProviders,
  applyAgentConfigLayer,
  createDefaultAgentConfig,
  parseConfigWithSchema,
  type DroneConfigLayer,
  type DroneResolvedConfig,
} from 'drone-core';
import {
  formatMigrationNotice,
  migrateLegacyProviderConfig,
} from './provider-migration.js';
import { enforceProviderScopePolicy } from './provider-scope-policy.js';

export const CONFIG_DIRECTORY_NAME = '.drone-agent';
export const CONFIG_FILE_NAME = 'config.json';

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfigLayer(
  scope: DroneConfigLayer['scope'],
  filePath: string
): Promise<DroneConfigLayer | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }

  const fileContents = await readFile(filePath, 'utf-8');
  const parsed = parseConfigWithSchema(JSON.parse(fileContents), filePath);

  if (!parsed) {
    throw new Error(
      `Failed to parse config file "${filePath}": does not conform to schema.`
    );
  }

  return {
    scope,
    path: filePath,
    config: parsed,
  };
}

export async function findProjectConfigPath(
  startDirectory: string
): Promise<string | undefined> {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    const candidate = path.join(
      currentDirectory,
      CONFIG_DIRECTORY_NAME,
      CONFIG_FILE_NAME
    );
    if (await pathExists(candidate)) {
      return candidate;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

export interface LoadAgentConfigOptions {
  /**
   * Override the default config directory.
   * When provided, the user config will be loaded from this directory
   * instead of ~/.drone-agent.
   */
  configDir?: string;
}

/**
 * Load the agent configuration from the default layered sources:
 * default -> user -> project
 *
 * @param startDirectory - Directory to start searching for project config
 * @param options - Optional configuration options
 */
export async function loadAgentConfig(
  startDirectory: string,
  options: LoadAgentConfigOptions = {}
): Promise<DroneResolvedConfig> {
  const { configDir } = options;

  const layers: DroneConfigLayer[] = [
    {
      scope: 'default',
      config: createDefaultAgentConfig(),
    },
  ];

  // Determine user config path - use configDir if provided, otherwise use home directory
  const userConfigDir = configDir || os.homedir();
  const userConfigPath = path.join(
    userConfigDir,
    CONFIG_DIRECTORY_NAME,
    CONFIG_FILE_NAME
  );
  const userLayer = await loadConfigLayer('user', userConfigPath);
  if (userLayer) {
    layers.push(userLayer);
  }

  const projectConfigPath = await findProjectConfigPath(startDirectory);
  if (projectConfigPath) {
    const projectLayer = await loadConfigLayer('project', projectConfigPath);
    if (projectLayer) {
      layers.push(projectLayer);
    }
  }

  let mergedConfig = createDefaultAgentConfig();
  for (const layer of layers) {
    mergedConfig = applyAgentConfigLayer(mergedConfig, layer.config);
  }

  // Legacy section → providers migration runs after the full merge so
  // swarm-injected legacy sections are migrated too. Interpolation already
  // happened per-layer at parse time (env is node-local, so per-layer and
  // post-merge interpolation are equivalent).
  const migration = migrateLegacyProviderConfig(mergedConfig);
  mergedConfig = migration.config;

  const scopePolicy = enforceProviderScopePolicy(layers);
  if (scopePolicy.errors.length > 0) {
    throw new Error(
      `Provider config scope violations:\n  - ${scopePolicy.errors.join('\n  - ')}`
    );
  }

  const validation = validateProviders(mergedConfig.providers);
  if (validation.errors.length > 0) {
    throw new Error(
      `Invalid providers config:\n  - ${[...validation.errors].join('\n  - ')}`
    );
  }

  return {
    config: mergedConfig,
    layers,
    migrationNotice: formatMigrationNotice(migration),
    warnings: [...scopePolicy.warnings, ...validation.warnings],
  };
}
