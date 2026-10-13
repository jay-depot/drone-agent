/**
 * Legacy `enabledPlugins` array → override-map translation.
 *
 * The pre-map config format expressed plugin enablement as a whitelist
 * array (`["llm", "echo"]`). The canonical form is now a sparse override
 * map (`{ llm: true, echo: true }`) layered over the built-in default
 * plugin set. This module translates the raw on-disk shape; the schema
 * keeps a tolerant read so both forms parse during the deprecation window.
 */

export type EnabledPluginsMigrateResult = {
  raw: Record<string, unknown>;
  changed: boolean;
};

/**
 * Translate a raw config object's legacy `enabledPlugins` array to map form.
 * Returns the input unchanged when it is not an array (already a map, null,
 * or absent).
 */
export function migrateEnabledPluginsRaw(
  raw: Record<string, unknown>
): EnabledPluginsMigrateResult {
  const value = raw.enabledPlugins;
  if (!Array.isArray(value)) return { raw, changed: false };
  const migrated = { ...raw };
  migrated.enabledPlugins = Object.fromEntries(
    (value as string[]).map(id => [id, true])
  );
  return { raw: migrated, changed: true };
}

export const ENABLED_PLUGINS_MIGRATION_NOTICE =
  '`enabledPlugins` was translated from a list to an override map; it now ' +
  'layers over the default plugin set, so default-enabled plugins your list ' +
  'omitted will also load.';
