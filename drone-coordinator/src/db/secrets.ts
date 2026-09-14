import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import { maskScalar } from '../mask.js';

/**
 * A coordinator-stored secret: a named value managed through the Stored
 * Secrets UI and referenced from coordinator_config entries via
 * `${secret:NAME}` tokens. Raw values exist only in this module — listing
 * functions return masked values, and `getSecretValue` exists solely for
 * the config distribution resolver.
 */
export interface StoredSecret {
  name: string;
  maskedValue: string;
  createdAt: number;
  updatedAt: number;
}

interface CoordinatorSecretsRow {
  name: string;
  value: string;
  created_at: number;
  updated_at: number;
}

function rowToStored(row: CoordinatorSecretsRow): StoredSecret {
  return {
    name: row.name,
    maskedValue: maskScalar(row.value),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listSecrets(): StoredSecret[] {
  const rows = getDatabase()
    .prepare(
      'SELECT name, value, created_at, updated_at FROM coordinator_secrets ORDER BY name'
    )
    .all() as CoordinatorSecretsRow[];
  return rows.map(row => ({
    name: row.name,
    maskedValue: maskScalar(row.value),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Raw stored value for one secret. Internal use only (config distribution
 * resolution and reference validation) — never log, never return from a
 * UI-facing route.
 */
export function getSecretValue(name: string): string | undefined {
  const row = getDatabase()
    .prepare('SELECT value FROM coordinator_secrets WHERE name = ?')
    .get(name) as { value: string } | undefined;
  return row?.value;
}

export function getSecretNames(): string[] {
  const rows = getDatabase()
    .prepare('SELECT name FROM coordinator_secrets ORDER BY name')
    .all() as { name: string }[];
  return rows.map(row => row.name);
}

function getSecretRow(name: string): CoordinatorSecretsRow | undefined {
  return getDatabase()
    .prepare(
      'SELECT name, value, created_at, updated_at FROM coordinator_secrets WHERE name = ?'
    )
    .get(name) as CoordinatorSecretsRow | undefined;
}

export function upsertSecret(req: {
  name: string;
  value: string;
}): StoredSecret {
  const now = Date.now();
  getDatabase()
    .prepare(
      `
    INSERT INTO coordinator_secrets (name, value, created_at, updated_at)
    VALUES (@name, @value, @now, @now)
    ON CONFLICT(name) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `
    )
    .run({ name: req.name, value: req.value, now });
  logger.info(`Upserted stored secret: ${req.name}`);
  const row = getSecretRow(req.name);
  if (!row) {
    throw new Error(`Failed to read back stored secret: ${req.name}`);
  }
  return {
    name: row.name,
    maskedValue: maskScalar(row.value),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function deleteSecret(name: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM coordinator_secrets WHERE name = ?')
    .run(name);
  if (result.changes > 0) {
    logger.info(`Deleted stored secret: ${name}`);
  }
  return result.changes > 0;
}