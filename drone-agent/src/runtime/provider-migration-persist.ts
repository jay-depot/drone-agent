import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import {
  listRawLegacySections,
  migrateLegacyProviderConfigRaw,
} from './provider-migration.js';

/**
 * Durable legacy→providers migration.
 *
 * For every file-backed config layer whose RAW file still carries legacy
 * LLM sections, rewrite that file in canonical providers form. Content is
 * derived from the freshly parsed raw JSON — never the merged/interpolated
 * config — so `${VAR}` templates stay templates on disk and literals are
 * relocated unchanged (with an advisory warning, never rewritten).
 *
 * Scope policy: user-scope files are rewritten; project-scope files never
 * receive `providers` (banned by provider-scope-policy) and only produce a
 * redirect warning; swarm underlays have no file path here and are skipped
 * structurally. Every rewrite is preceded by a timestamped `.old` backup of
 * the original bytes, and lands atomically via tmp-file + rename.
 */

export type PersistableConfigLayer = {
  scope: string;
  path?: string;
};

export type MigrationPersistOutcome = {
  /** Config files rewritten in canonical form. */
  writtenPaths: string[];
  /** Pre-migration backups created (one per rewritten file). */
  backupPaths: string[];
  /** Advisory warnings (inline keys, project-scope redirect, parse skips). */
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
 * Rewrite every file-backed layer that still contains legacy sections.
 * Idempotent: a canonical file triggers no read-modify-write at all.
 */
export async function persistLegacyProviderMigration(
  layers: PersistableConfigLayer[]
): Promise<MigrationPersistOutcome> {
  const outcome: MigrationPersistOutcome = {
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
        `Skipping migration persistence for ${layer.path}: file could not be parsed as a JSON object.`
      );
      continue;
    }
    if (listRawLegacySections(raw).length === 0) {
      continue;
    }

    if (layer.scope === 'project') {
      outcome.warnings.push(
        `Legacy LLM config sections found at project scope (${layer.path}). Providers are banned at project scope — define them in user config (~/.drone-agent/config.json); they were applied in-memory for this session only.`
      );
      continue;
    }

    const backupPath = `${layer.path}.${sanitizeTimestamp(new Date())}.old`;
    await copyFile(layer.path, backupPath);

    const migrated = migrateLegacyProviderConfigRaw(raw, {
      stripLegacy: true,
    });

    const tmpPath = `${layer.path}.tmp-migration`;
    await writeFile(
      tmpPath,
      JSON.stringify(migrated.raw, null, 2) + '\n',
      'utf-8'
    );
    await rename(tmpPath, layer.path);

    outcome.writtenPaths.push(layer.path);
    outcome.backupPaths.push(backupPath);

    for (const section of migrated.inlineKeySections) {
      outcome.warnings.push(
        `Provider "${section}" has a literal API key in ${layer.path}; consider replacing it with a \${VAR} environment template.`
      );
    }
  }

  return outcome;
}
