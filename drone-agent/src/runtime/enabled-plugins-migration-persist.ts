import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import {
  ENABLED_PLUGINS_MIGRATION_NOTICE,
  migrateEnabledPluginsRaw,
} from './enabled-plugins-migration.js';

/**
 * Durable legacy `enabledPlugins` array → override-map migration.
 *
 * For every file-backed config layer whose RAW file still carries a legacy
 * `enabledPlugins` array, rewrite that file in override-map form. Content is
 * derived from the freshly parsed raw JSON — never the merged/interpolated
 * config — so `${VAR}` templates stay templates on disk.
 *
 * Unlike the providers migration, project scope IS rewritten here: the
 * override map carries no provider references, so it trips no scope policy.
 * Every rewrite is preceded by a timestamped `.old` backup of the original
 * bytes, and lands atomically via tmp-file + rename. Idempotent.
 */

export type PersistableConfigLayer = {
  scope: string;
  path?: string;
};

export type EnabledPluginsPersistOutcome = {
  /** Config files rewritten to override-map form. */
  writtenPaths: string[];
  /** Pre-migration backups created (one per rewritten file). */
  backupPaths: string[];
  /** Advisory warnings (parse skips). */
  warnings: string[];
};

function sanitizeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function readRawConfig(
  filePath: string
): Promise<Record<string, unknown> | undefined> {
  try {
    const contents = await readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(contents);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rewrite every file-backed layer whose raw `enabledPlugins` is still an
 * array. Returns an advisory notice string describing the translation when
 * at least one file changed, else `undefined`. Idempotent: a map-form file
 * triggers no read-modify-write at all.
 */
export async function persistEnabledPluginsMigration(
  layers: PersistableConfigLayer[]
): Promise<{ outcome: EnabledPluginsPersistOutcome; notice?: string }> {
  const outcome: EnabledPluginsPersistOutcome = {
    writtenPaths: [],
    backupPaths: [],
    warnings: [],
  };

  for (const layer of layers) {
    if (!layer.path || (layer.scope !== 'user' && layer.scope !== 'project')) {
      continue;
    }
    const raw = await readRawConfig(layer.path);
    if (!raw) {
      outcome.warnings.push(
        `Skipping enabledPlugins migration persistence for ${layer.path}: file could not be parsed as a JSON object.`
      );
      continue;
    }

    const migrated = migrateEnabledPluginsRaw(raw);
    if (!migrated.changed) {
      continue;
    }

    const backupPath = `${layer.path}.${sanitizeTimestamp(new Date())}.old`;
    await copyFile(layer.path, backupPath);

    const tmpPath = `${layer.path}.tmp-migration`;
    await writeFile(
      tmpPath,
      JSON.stringify(migrated.raw, null, 2) + '\n',
      'utf-8'
    );
    await rename(tmpPath, layer.path);

    outcome.writtenPaths.push(layer.path);
    outcome.backupPaths.push(backupPath);
  }

  const notice =
    outcome.writtenPaths.length > 0
      ? ENABLED_PLUGINS_MIGRATION_NOTICE
      : undefined;

  return { outcome, notice };
}
