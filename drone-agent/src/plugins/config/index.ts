import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigGetBlock } from '../../tui/components/ConfigGetBlock.js';
import { ConfigSetBlock } from '../../tui/components/ConfigSetBlock.js';
import {
  applyAgentConfigLayer,
  createDefaultAgentConfig,
  type DroneAgentConfig,
  type DroneConfigInjector,
  type DroneConfigLayer,
  type DronePlugin,
  type DroneToolJsonSchema,
} from 'drone-core';
import {
  CONFIG_DIRECTORY_NAME,
  CONFIG_FILE_NAME,
  findProjectConfigPath,
  loadConfigLayer,
} from '../../runtime/config.js';
import { deepSet } from './helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DroneConfigCapability = {
  /** Returns the resolved DroneAgentConfig (merged across all layers). */
  getConfig: () => DroneAgentConfig;
  /** Returns the config layers (default, user, project) with their file paths. */
  getLayers: () => Promise<DroneConfigLayer[]>;
  /**
   * Write a config value to a specific scope.
   * @param scope 'project' or 'user' (defaults to 'project')
   * @param key Dot-notation key path (e.g. 'ollama.model')
   * @param value The JSON value to set
   */
  setValue: (
    scope: 'project' | 'user',
    key: string,
    value: unknown
  ) => Promise<void>;
  /** Register a config injector for injecting config as underlay. */
  registerInjector: (injector: DroneConfigInjector) => void;
  /** Unregister a config injector by id. */
  unregisterInjector: (injectorId: string) => void;
  /** Get all registered injectors sorted by precedence. */
  getInjectors: () => DroneConfigInjector[];
};

// ---------------------------------------------------------------------------
// Config Injector Registry
// ---------------------------------------------------------------------------

const configInjectors: import('drone-core').DroneConfigInjector[] = [];

function registerInjector(
  injector: import('drone-core').DroneConfigInjector
): void {
  // Remove existing injector with same id
  const existingIdx = configInjectors.findIndex(i => i.id === injector.id);
  if (existingIdx !== -1) {
    configInjectors.splice(existingIdx, 1);
  }
  // Insert in precedence order (lower first)
  const idx = configInjectors.findIndex(
    i => i.precedence > injector.precedence
  );
  if (idx === -1) {
    configInjectors.push(injector);
  } else {
    configInjectors.splice(idx, 0, injector);
  }
}

function unregisterInjector(injectorId: string): void {
  const idx = configInjectors.findIndex(i => i.id === injectorId);
  if (idx !== -1) {
    configInjectors.splice(idx, 1);
  }
}

function getInjectors(): import('drone-core').DroneConfigInjector[] {
  return [...configInjectors];
}

// ---------------------------------------------------------------------------
// Known config key paths (for validation in config.set)
// ---------------------------------------------------------------------------

const KNOWN_CONFIG_KEYS: string[] = [
  // Top-level
  'enabledPlugins',
  'externalPlugins',
  'trustedPlugins',
  'systemPrompt',
  'activePersona',
  'ollama',
  'session',
  'lsp',
  'mcp',
  'compaction',
  'memory',
  'log',
  'promptFile',
  'search',
  // ollama.*
  'ollama.host',
  'ollama.model',
  // session.*
  'session.contextWindowTokens',
  'session.responseReserveTokens',
  'session.maxToolIterations',
  'session.promptOnToolIterationLimit',
  'session.maxToolResultTokensPercent',
  'session.retry.maxRetries',
  'session.retry.maxWaitMs',
  'session.retry.promptOnError',
  'session.retry.backoffBaseMs',
  'session.retry.backoffFactor',
  // llm.*
  'llm.active',
  'llm.reasoningLevel',
  // lsp.*
  // lsp.*
  'lsp.enabled',
  'lsp.diagnosticTokenBudget',
  'lsp.requestTimeoutMs',
  'lsp.preferExternal',
  'lsp.autoInstall',
  // mcp.*
  'mcp.enabled',
  'mcp.requestTimeoutMs',
  'mcp.retryCount',
  'mcp.retryDelayMs',
  'mcp.maxListPages',
  'mcp.maxListItems',
  'mcp.compatibilityMode',
  // compaction.*
  'compaction.enabled',
  'compaction.strategy',
  'compaction.softThresholdPercent',
  'compaction.slicePercent',
  'compaction.minTurnsToCompact',
  'compaction.summaryMaxTokens',
  'compaction.summaryBudgetPercent',
  // memory.*
  'memory.enabled',
  // log.*
  'log.enabled',
  // promptFile.*
  'promptFile.enabled',
  'promptFile.files',
  // search.*
  'search.enabled',
  'search.paths',
  'search.userEmbeddingProvider',
  'search.projectEmbeddingProvider',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get a value at a dot-notation path in a nested object.
 * Returns `undefined` if the path doesn't exist.
 */
function getByPath(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Validate that a dot-notation key path is a known config key.
 * Throws if unknown.
 */
function validateConfigKey(key: string): void {
  if (!KNOWN_CONFIG_KEYS.includes(key)) {
    throw new Error(
      `Unknown config key "${key}". Valid keys: ${KNOWN_CONFIG_KEYS.join(', ')}`
    );
  }
}

/**
 * Resolve the user-level config file path.
 */
function resolveUserConfigPath(): string {
  return path.join(os.homedir(), CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);
}

/**
 * Determine which layer a key's value came from by walking layers
 * in reverse (project → user → default) and checking if the layer
 * defines the key.
 */
function resolveLayerProvenance(
  key: string,
  layers: DroneConfigLayer[]
): string {
  // Walk layers in reverse (highest priority first)
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const value = getByPath(layer.config as Record<string, unknown>, key);
    if (value !== undefined) {
      return layer.scope;
    }
  }
  return 'default';
}

/**
 * Collect all leaf keys with their provenance from the layers.
 */
function collectProvenance(layers: DroneConfigLayer[]): Record<string, string> {
  const provenance: Record<string, string> = {};
  for (const key of KNOWN_CONFIG_KEYS) {
    // Skip top-level container keys — only track leaf keys
    if (key.includes('.')) {
      provenance[key] = resolveLayerProvenance(key, layers);
    }
  }
  return provenance;
}

/**
 * Read the existing config file for a scope, deep-set the value,
 * and write it back. Creates the file if it doesn't exist.
 */
async function writeConfigValue(
  scope: 'project' | 'user',
  key: string,
  value: unknown
): Promise<string> {
  const filePath =
    scope === 'user'
      ? resolveUserConfigPath()
      : await findProjectConfigPath(process.cwd());

  if (!filePath) {
    // No existing config file — create one at the default location
    const resolvedPath =
      scope === 'user'
        ? resolveUserConfigPath()
        : path.join(process.cwd(), CONFIG_DIRECTORY_NAME, CONFIG_FILE_NAME);

    await mkdir(path.dirname(resolvedPath), { recursive: true });
    const newConfig: Record<string, unknown> = {};
    deepSet(newConfig, key, value);
    await writeFile(
      resolvedPath,
      JSON.stringify(newConfig, null, 2) + '\n',
      'utf-8'
    );
    return resolvedPath;
  }

  // Read existing config
  let config: Record<string, unknown> = {};
  try {
    const raw = await readFile(filePath, 'utf-8');
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is corrupt — start fresh
    config = {};
  }

  deepSet(config, key, value);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return filePath;
}

/**
 * Re-discover config layers (default, user, project) for provenance
 * and listing purposes.
 */
async function discoverLayers(): Promise<DroneConfigLayer[]> {
  const layers: DroneConfigLayer[] = [
    {
      scope: 'default',
      config: createDefaultAgentConfig(),
    },
  ];

  const userConfigPath = resolveUserConfigPath();
  const userLayer = await loadConfigLayer('user', userConfigPath);
  if (userLayer) {
    layers.push(userLayer);
  }

  const projectConfigPath = await findProjectConfigPath(process.cwd());
  if (projectConfigPath) {
    const projectLayer = await loadConfigLayer('project', projectConfigPath);
    if (projectLayer) {
      layers.push(projectLayer);
    }
  }

  return layers;
}

/**
 * Merge discovered layers into a single DroneAgentConfig.
 */
function mergeLayers(layers: DroneConfigLayer[]): DroneAgentConfig {
  let merged = createDefaultAgentConfig();
  for (const layer of layers) {
    merged = applyAgentConfigLayer(merged, layer.config);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

const configGetSchema: DroneToolJsonSchema = {
  type: 'object',
  properties: {
    showLayers: {
      type: 'boolean',
      description:
        'If true, include layer info (scope, path, keys) in the response.',
    },
    key: {
      type: 'string',
      description:
        'Optional dot-notation key path (e.g. "ollama.model"). When omitted, returns the full resolved config with provenance info.',
    },
  },
  additionalProperties: false,
};

const configSetSchema: DroneToolJsonSchema = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      description:
        'Config scope to write to: "project" or "user". Defaults to "project".',
      enum: ['project', 'user'],
    },
    key: {
      type: 'string',
      description:
        'Dot-notation key path (e.g. "ollama.model", "compaction.enabled").',
    },
    value: {
      type: 'object',
      description:
        'The value to set. Can be a primitive, object, or array depending on the key.',
    },
  },
  required: ['key', 'value'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const configPlugin: DronePlugin = {
  metadata: {
    id: 'config',
    name: 'Config',
    version: '0.1.0',
    description:
      'Read and update drone-agent configuration. Exposes tools for viewing config with layer provenance and writing config values.',
    defaultEnabled: true,
  },
  register: async registration => {
    // ── State ──────────────────────────────────────────────────────
    // Cache the layers so we don't re-discover on every tool call.
    // Re-discovered lazily on first use.
    let cachedLayers: DroneConfigLayer[] | null = null;

    async function getLayers(): Promise<DroneConfigLayer[]> {
      if (!cachedLayers) {
        cachedLayers = await discoverLayers();
      }
      return cachedLayers;
    }

    // ── config.get ──────────────────────────────────────────────────
    registration.registerTool({
      name: 'get',
      description:
        'Returns the current resolved drone-agent configuration. ' +
        'When called without a key, returns the full config with a _provenance map ' +
        'showing which layer (default/user/project) each setting came from. ' +
        'When called with a dot-notation key (e.g. "ollama.model"), returns just that value with its source layer. ' +
        'Pass showLayers=true to include layer info (scope, path, keys) in the response.',
      inputSchema: configGetSchema,
      execute: async input => {
        const layers = await getLayers();
        // Merge the discovered layers ourselves so values and provenance
        // are consistent (the engine's config may differ from disk).
        const mergedConfig = mergeLayers(layers);
        const key = input.key as string | undefined;
        const showLayers = input.showLayers === true;

        if (key) {
          validateConfigKey(key);
          const value = getByPath(
            mergedConfig as unknown as Record<string, unknown>,
            key
          );
          const source = resolveLayerProvenance(key, layers);
          if (showLayers) {
            const layerInfo = layers.map(layer => ({
              scope: layer.scope,
              path: layer.path ?? null,
              keys: Object.keys(layer.config),
            }));
            return JSON.stringify(
              { key, value, source, layers: layerInfo },
              null,
              2
            );
          }
          return JSON.stringify(
            {
              key,
              value,
              source,
            },
            null,
            2
          );
        }

        // Full config with provenance
        const provenance = collectProvenance(layers);
        if (showLayers) {
          const layerInfo = layers.map(layer => ({
            scope: layer.scope,
            path: layer.path ?? null,
            keys: Object.keys(layer.config),
          }));
          return JSON.stringify(
            { ...mergedConfig, _provenance: provenance, layers: layerInfo },
            null,
            2
          );
        }
        return JSON.stringify(
          {
            ...mergedConfig,
            _provenance: provenance,
          },
          null,
          2
        );
      },
      renderComponent: state => ConfigGetBlock({ state }),
    });

    // ── config.set ──────────────────────────────────────────────────
    registration.registerTool({
      name: 'set',
      description:
        'Write a config value to a .drone-agent/config.json file. ' +
        'Defaults to the project scope (writes to <project>/.drone-agent/config.json). ' +
        'Pass scope="user" to write to ~/.drone-agent/config.json instead. ' +
        'The change takes effect on the next session restart. ' +
        'Supports dot-notation key paths (e.g. "ollama.model", "compaction.enabled") ' +
        'and nested object values.',
      inputSchema: configSetSchema,
      execute: async input => {
        const scope = (input.scope as string) || 'project';
        if (scope !== 'project' && scope !== 'user') {
          throw new Error(
            'config.set scope must be "project" or "user". Got: "' +
              scope +
              '".'
          );
        }

        const key = input.key as string;
        if (typeof key !== 'string' || key.trim().length === 0) {
          throw new Error('config.set requires a non-empty key.');
        }

        validateConfigKey(key);

        const value = input.value;
        const filePath = await writeConfigValue(scope, key, value);

        // Invalidate the layer cache so subsequent reads pick up the change
        cachedLayers = null;

        return JSON.stringify(
          {
            ok: true,
            scope,
            key,
            filePath,
            message: `Config value "${key}" written to ${scope} scope (${filePath}). The change will take effect on the next session restart.`,
          },
          null,
          2
        );
      },
      renderComponent: state => ConfigSetBlock({ state }),
    });

    // ── Capability ──────────────────────────────────────────────────
    const capability: DroneConfigCapability = {
      getConfig: () => registration.getConfig(),
      getLayers: async () => {
        const layers = await getLayers();
        return layers;
      },
      setValue: async (scope, key, value) => {
        validateConfigKey(key);
        await writeConfigValue(scope, key, value);
        cachedLayers = null;
      },
      registerInjector: injector => {
        registerInjector(injector);
      },
      unregisterInjector: injectorId => {
        unregisterInjector(injectorId);
      },
      getInjectors: () => getInjectors(),
    };
    registration.offer(capability);

    // ── Lifecycle ───────────────────────────────────────────────────
    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info(
        'config plugin ready (use config.get, config.set tools)'
      );
    });
  },
};
