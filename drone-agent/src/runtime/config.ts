import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  validateProviders,
  validateModelRoles,
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
import { persistLegacyProviderMigration } from './provider-migration-persist.js';
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

export interface ProjectConfigResolution {
  /** Discovered project config file path, or undefined when none exists. */
  path?: string;
  /**
   * Set when discovery encountered a config file identical to the user
   * config and skipped it rather than loading it a second time as
   * project scope.
   */
  skippedDuplicatePath?: string;
}

/**
 * Walk up from startDirectory to the filesystem root looking for the
 * nearest project config. The walk dedupes against the effective user
 * config path by lexical identity: launching from $HOME (or any directory
 * whose ancestors contain only the user's own .drone-agent directory)
 * would otherwise rediscover the user config and load it a second time as
 * project scope, tripping the provider scope policy. Symlinked homes are
 * out of scope for the comparison.
 */
export async function resolveProjectConfig(
  startDirectory: string,
  userConfigPath?: string
): Promise<ProjectConfigResolution> {
  const resolvedUserConfigPath = path.resolve(
    userConfigPath ??
      path.join(os.homedir(), CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME)
  );

  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    const candidate = path.join(
      currentDirectory,
      CONFIG_DIRECTORY_NAME,
      CONFIG_FILE_NAME
    );
    if (await pathExists(candidate)) {
      if (path.resolve(candidate) === resolvedUserConfigPath) {
        return { skippedDuplicatePath: candidate };
      }
      return { path: candidate };
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return {};
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

  const projectConfigResolution = await resolveProjectConfig(
    startDirectory,
    userConfigPath
  );
  if (projectConfigResolution.path) {
    const projectLayer = await loadConfigLayer(
      'project',
      projectConfigResolution.path
    );
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

  // Persist the migration to the file-backed layers so it happens exactly
  // once. Derived from the raw files (not this merged object) so ${VAR}
  // templates stay templates on disk.
  const persisted = await persistLegacyProviderMigration(
    layers.map(layer => ({ scope: layer.scope, path: layer.path }))
  );

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

  const modelRoleWarnings = validateModelRoles(
    mergedConfig.providers,
    mergedConfig.llm?.modelRoles
  );

  return {
    config: mergedConfig,
    layers,
    migrationNotice: formatMigrationNotice(migration, {
      backupPaths: persisted.backupPaths,
    }),
    warnings: [
      ...(projectConfigResolution.skippedDuplicatePath !== undefined
        ? [
            `Found ${projectConfigResolution.skippedDuplicatePath} while searching for project config, but it is the same file as the user config; skipping redundant project-scope load.`,
          ]
        : []),
      ...persisted.warnings,
      ...scopePolicy.warnings,
      ...validation.warnings,
      ...modelRoleWarnings,
    ],
  };
}
