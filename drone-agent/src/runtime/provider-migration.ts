import type { DroneAgentConfig } from 'drone-core';

/**
 * Legacy → providers migration.
 *
 * Self-contained and deletable: when the migration window closes, delete
 * this file and its tests. One structural transform backs two entry points:
 * `migrateLegacyProviderConfig` operates on the decoded config (runtime
 * merge path, unchanged public behavior); `migrateLegacyProviderConfigRaw`
 * operates on raw parsed JSON (persistence path — `${VAR}` templates stay
 * templates because env interpolation never ran on this shape).
 */

export type MigrationResult = {
  /** The config with synthetic providers + seeded llm.active applied. */
  config: DroneAgentConfig;
  /** One-line-per-item report for the deprecation notice. */
  migratedSections: string[];
  /** True when anything changed (idempotency check). */
  changed: boolean;
};

export type RawMigrationResult = {
  /** The transformed raw object (new container; nested inputs untouched). */
  raw: Record<string, unknown>;
  /** Legacy section names that produced synthetic providers entries. */
  migratedSections: string[];
  /**
   * Sections relocated with a literal (non-template) apiKey — surfaced by
   * the persistence layer as an advisory `${VAR}` nudge, never rewritten.
   */
  inlineKeySections: string[];
  /** Seeded `<providerId>/<modelLocalId>` selection, when one was set. */
  seededActive?: string;
  /** True when the transform changed anything (including strip-only). */
  changed: boolean;
};

/** Legacy section names consulted during migration. */
export const LEGACY_SECTIONS = [
  'ollama',
  'openai',
  'anthropic',
  'openrouter',
] as const;

type RawShape = Record<string, unknown>;

export type MigrateRawOptions = {
  /**
   * Remove all four legacy sections from the output regardless of whether
   * they contributed synthetic entries (mixed-format cleanup policy).
   */
  stripLegacy?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sectionOf(raw: RawShape, name: string): Record<string, unknown> {
  const value = raw[name];
  return isRecord(value) ? value : {};
}

function isVarTemplate(value: unknown): boolean {
  return typeof value === 'string' && value.trimStart().startsWith('${');
}

/** Legacy `{ id, contextWindow }[]` → declared models map (contextWindow only). */
function toRawModelMap(
  models: unknown
): Record<string, { contextWindow?: number }> {
  const map: Record<string, { contextWindow?: number }> = {};
  if (!Array.isArray(models)) {
    return map;
  }
  for (const item of models) {
    if (!isRecord(item)) {
      continue;
    }
    const id = item['id'];
    if (typeof id !== 'string' || id.length === 0) {
      continue;
    }
    const contextWindow = item['contextWindow'];
    map[id] = typeof contextWindow === 'number' ? { contextWindow } : {};
  }
  return map;
}

/** Which legacy sections carry meaningful configuration in a raw shape. */
export function listRawLegacySections(raw: RawShape): string[] {
  const present: string[] = [];
  for (const name of LEGACY_SECTIONS) {
    const legacy = sectionOf(raw, name);
    if (name === 'ollama') {
      if (isNonEmptyString(legacy['model'])) {
        present.push(name);
      }
    } else if (legacy['apiKey']) {
      present.push(name);
    }
  }
  return present;
}

/**
 * Apply the legacy→providers structural transform to a raw parsed JSON
 * object. Never mutates the input or its nested objects; returns a fresh
 * container. With `stripLegacy`, all four legacy sections are removed
 * unconditionally (the persistence layer's mixed-format cleanup policy).
 */
export function migrateLegacyProviderConfigRaw(
  input: RawShape,
  options: MigrateRawOptions = {}
): RawMigrationResult {
  const raw: RawShape = { ...input };
  const migratedSections: string[] = [];
  const inlineKeySections: string[] = [];

  const existingProviders = isRecord(raw['providers']) ? raw['providers'] : {};
  const providers: Record<string, unknown> = { ...existingProviders };
  const hasSynthetic = Object.keys(existingProviders).length > 0;

  if (!hasSynthetic) {
    const ollama = sectionOf(raw, 'ollama');
    if (isNonEmptyString(ollama['model'])) {
      providers['ollama'] = {
        protocol: 'ollama',
        baseUrl: ollama['host'],
        models: { [ollama['model']]: {} },
      };
      migratedSections.push('ollama');
    }

    const openai = sectionOf(raw, 'openai');
    if (openai['apiKey']) {
      providers['openai'] = {
        protocol: 'openai',
        baseUrl: openai['baseUrl'],
        apiKey: openai['apiKey'],
        orgId: openai['orgId'],
        models: toRawModelMap(openai['models']),
      };
      migratedSections.push('openai');
      if (!isVarTemplate(openai['apiKey'])) {
        inlineKeySections.push('openai');
      }
    }

    const anthropic = sectionOf(raw, 'anthropic');
    if (anthropic['apiKey']) {
      providers['anthropic'] = {
        protocol: 'anthropic',
        baseUrl: anthropic['baseUrl'],
        apiKey: anthropic['apiKey'],
        apiVersion: anthropic['apiVersion'],
        models: toRawModelMap(anthropic['models']),
      };
      migratedSections.push('anthropic');
      if (!isVarTemplate(anthropic['apiKey'])) {
        inlineKeySections.push('anthropic');
      }
    }

    const openrouter = sectionOf(raw, 'openrouter');
    if (openrouter['apiKey']) {
      providers['openrouter'] = {
        protocol: 'openrouter',
        baseUrl: openrouter['baseUrl'],
        apiKey: openrouter['apiKey'],
        models: toRawModelMap(openrouter['models']),
      };
      migratedSections.push('openrouter');
      if (!isVarTemplate(openrouter['apiKey'])) {
        inlineKeySections.push('openrouter');
      }
    }
  }

  const seededActive = seedRawActiveModel(raw, providers);

  const strippedAny =
    options.stripLegacy === true && LEGACY_SECTIONS.some(name => name in input);
  if (options.stripLegacy) {
    for (const name of LEGACY_SECTIONS) {
      delete raw[name];
    }
  }

  raw['providers'] = providers;

  return {
    raw,
    migratedSections,
    inlineKeySections,
    ...(seededActive !== undefined ? { seededActive } : {}),
    changed:
      migratedSections.length > 0 || seededActive !== undefined || strippedAny,
  };
}

/**
 * Seed `llm.active` from the legacy provider selection. Returns undefined
 * when there is nothing to seed (already set, or no usable selection).
 */
function seedRawActiveModel(
  raw: RawShape,
  providers: Record<string, unknown>
): string | undefined {
  const llm = sectionOf(raw, 'llm');
  if (llm['active'] || !isNonEmptyString(llm['provider'])) {
    return undefined;
  }
  const providerId = llm['provider'];
  const provider = providers[providerId];
  if (!isRecord(provider)) {
    return undefined;
  }

  let modelId: string | undefined;
  if (providerId === 'ollama') {
    modelId = sectionOf(raw, 'ollama')['model'] as string | undefined;
  } else {
    modelId = sectionOf(raw, providerId)['defaultModel'] as string | undefined;
  }

  const models = isRecord(provider['models']) ? provider['models'] : {};
  if (!isNonEmptyString(modelId)) {
    const first = Object.keys(models)[0];
    if (!first) {
      return undefined;
    }
    modelId = first;
  }

  if (!(modelId in models)) {
    provider['models'] = { ...models, [modelId]: {} };
  }

  const active = `${providerId}/${modelId}`;
  raw['llm'] = { ...llm, active };
  return active;
}

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
  const result = migrateLegacyProviderConfigRaw(config as unknown as RawShape);
  return {
    config: result.raw as unknown as DroneAgentConfig,
    migratedSections: result.migratedSections,
    changed: result.changed,
  };
}

/**
 * Build the one-time deprecation notice body. Empty when nothing migrated.
 * When persistence outcomes are supplied, the notice reflects the saved
 * state and points at the backups.
 */
export function formatMigrationNotice(
  result: MigrationResult,
  persisted?: { backupPaths: string[] }
): string | undefined {
  if (result.migratedSections.length === 0) {
    return undefined;
  }
  let notice =
    'Migrated legacy LLM config sections to providers: ' +
    result.migratedSections.join(', ') +
    '.';
  if (persisted && persisted.backupPaths.length > 0) {
    notice +=
      ' Changes were saved automatically; pre-migration backups: ' +
      persisted.backupPaths.join(', ') +
      '.';
  } else {
    notice +=
      ' Update .drone-agent/config.json to the providers format; the legacy ' +
      'sections are deprecated and will stop being read in a future release.';
  }
  return notice;
}

/** Which legacy sections exist in a config (used by tests and the notice). */
export function listLegacySections(config: DroneAgentConfig): string[] {
  return listRawLegacySections(config as unknown as RawShape);
}
