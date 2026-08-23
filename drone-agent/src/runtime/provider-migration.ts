import type {
  DroneAgentConfig,
  DroneModelEntryConfig,
  DroneProviderConfig,
} from 'drone-core';

/**
 * Legacy → providers migration.
 *
 * Self-contained and deletable: when the migration window closes, delete
 * this file and its tests. Everything here operates on an already-merged
 * config object (defaults → user → project → swarm underlays) and returns
 * a migrated copy plus a human-readable report of what changed.
 */

export type MigrationResult = {
  /** The config with synthetic providers + seeded llm.active applied. */
  config: DroneAgentConfig;
  /** One-line-per-item report for the deprecation notice. */
  migratedSections: string[];
  /** True when anything changed (idempotency check). */
  changed: boolean;
};

/** Legacy section names consulted during migration. */
const LEGACY_SECTIONS = [
  'ollama',
  'openai',
  'anthropic',
  'openrouter',
] as const;

type LegacyModelList = Array<{ id: string; contextWindow: number }>;

/**
 * Migrate legacy `llm`/`ollama`/`openai`/`anthropic`/`openrouter` sections
 * into synthetic `providers` entries named after the sections. Idempotent:
 * when `providers` already has entries, legacy sections are ignored.
 *
 * Seeds `llm.active` from legacy `llm.provider` + the section's default
 * model, but never overwrites an existing `llm.active`.
 */
export function migrateLegacyProviderConfig(
  config: DroneAgentConfig
): MigrationResult {
  const migratedSections: string[] = [];
  const providers: Record<string, DroneProviderConfig> = {
    ...config.providers,
  };

  const hasSynthetic = Object.keys(config.providers).length > 0;

  if (!hasSynthetic) {
    if (looksConfigured(config.ollama)) {
      providers['ollama'] = {
        protocol: 'ollama',
        baseUrl: config.ollama.host,
        models: {
          [config.ollama.model]: {},
        },
      };
      migratedSections.push('ollama');
    }

    if (config.openai.apiKey) {
      providers['openai'] = {
        protocol: 'openai',
        baseUrl: config.openai.baseUrl,
        apiKey: config.openai.apiKey,
        orgId: config.openai.orgId,
        models: toModelMap(config.openai.models),
      };
      migratedSections.push('openai');
    }

    if (config.anthropic.apiKey) {
      providers['anthropic'] = {
        protocol: 'anthropic',
        baseUrl: config.anthropic.baseUrl,
        apiKey: config.anthropic.apiKey,
        apiVersion: config.anthropic.apiVersion,
        models: toModelMap(config.anthropic.models),
      };
      migratedSections.push('anthropic');
    }

    if (config.openrouter.apiKey) {
      providers['openrouter'] = {
        protocol: 'openrouter',
        baseUrl: config.openrouter.baseUrl,
        apiKey: config.openrouter.apiKey,
        models: toModelMap(config.openrouter.models),
      };
      migratedSections.push('openrouter');
    }
  }

  const active = seedActiveModel(config, providers);
  const changed = migratedSections.length > 0 || active !== undefined;

  return {
    config: {
      ...config,
      providers,
      ...(active !== undefined ? { llm: { ...config.llm, active } } : {}),
    },
    migratedSections,
    changed,
  };
}

/** The ollama section is "configured" when a model is set (host defaults). */
function looksConfigured(ollama: { host: string; model: string }): boolean {
  return ollama.model.trim().length > 0;
}

function toModelMap(
  models: LegacyModelList
): Record<string, DroneModelEntryConfig> {
  const map: Record<string, DroneModelEntryConfig> = {};
  for (const model of models) {
    map[model.id] = { contextWindow: model.contextWindow };
  }
  return map;
}

/**
 * Seed llm.active from the legacy provider selection. Returns undefined
 * when there is nothing to seed (already set, or no legacy selection).
 */
function seedActiveModel(
  config: DroneAgentConfig,
  providers: Record<string, DroneProviderConfig>
): string | undefined {
  if (config.llm.active) {
    return undefined;
  }
  const providerId = config.llm.provider;
  const provider = providers[providerId];
  if (!provider) {
    return undefined;
  }

  let modelId: string | undefined;
  if (providerId === 'ollama') {
    modelId = config.ollama.model;
  } else if (providerId === 'openai') {
    modelId = config.openai.defaultModel;
  } else if (providerId === 'anthropic') {
    modelId = config.anthropic.defaultModel;
  } else if (providerId === 'openrouter') {
    modelId = config.openrouter.defaultModel;
  }

  if (!modelId) {
    const first = Object.keys(provider.models ?? {})[0];
    if (!first) {
      return undefined;
    }
    modelId = first;
  }

  const models = provider.models ?? {};
  if (models[modelId] === undefined) {
    models[modelId] = {};
  }

  return `${providerId}/${modelId}`;
}

/**
 * Build the one-time deprecation notice body. Empty when nothing migrated.
 */
export function formatMigrationNotice(
  result: MigrationResult
): string | undefined {
  if (result.migratedSections.length === 0) {
    return undefined;
  }
  return (
    'Migrated legacy LLM config sections to providers: ' +
    result.migratedSections.join(', ') +
    '. Update .drone-agent/config.json to the providers format; the legacy ' +
    'sections are deprecated and will stop being read in a future release.'
  );
}

/** Which legacy sections exist in a config (used by tests and the notice). */
export function listLegacySections(config: DroneAgentConfig): string[] {
  const present: string[] = [];
  for (const section of LEGACY_SECTIONS) {
    if (section === 'ollama') {
      if (looksConfigured(config.ollama)) present.push(section);
    } else if (config[section].apiKey) {
      present.push(section);
    }
  }
  return present;
}
