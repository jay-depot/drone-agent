import { getDatabase } from './init.js';
import { logger } from '../logger.js';

/**
 * A global, allowlisted config entry distributed coordinator → beacon →
 * agent as a config underlay. Value is stored as a JSON string; `secret`
 * entries are masked on read and write-only on edit.
 */
export interface CoordinatorConfigEntry {
  key: string;
  value: string; // JSON string
  secret: boolean;
  description?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertCoordinatorConfigRequest {
  key: string;
  value: string; // JSON string
  secret?: boolean;
  description?: string | null;
}

interface CoordinatorConfigRow {
  key: string;
  value: string;
  secret: number;
  description: string | null;
  created_at: number;
  updated_at: number;
}

function rowToEntry(row: CoordinatorConfigRow): CoordinatorConfigEntry {
  return {
    key: row.key,
    value: row.value,
    secret: row.secret === 1,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCoordinatorConfig(): CoordinatorConfigEntry[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM coordinator_config ORDER BY key'
  );
  const rows = stmt.all() as CoordinatorConfigRow[];
  return rows.map(rowToEntry);
}

export function getCoordinatorConfig(
  key: string
): CoordinatorConfigEntry | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM coordinator_config WHERE key = ?'
  );
  const row = stmt.get(key) as CoordinatorConfigRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

export function upsertCoordinatorConfig(
  req: UpsertCoordinatorConfigRequest
): CoordinatorConfigEntry {
  const now = Date.now();
  const existing = getCoordinatorConfig(req.key);
  const secret = req.secret ?? existing?.secret ?? false;
  const description =
    req.description !== undefined ? req.description : existing?.description;
  const createdAt = existing?.createdAt ?? now;

  const stmt = getDatabase().prepare(`
    INSERT INTO coordinator_config (key, value, secret, description, created_at, updated_at)
    VALUES (@key, @value, @secret, @description, @createdAt, @updatedAt)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      secret = excluded.secret,
      description = excluded.description,
      updated_at = excluded.updated_at
  `);
  stmt.run({
    key: req.key,
    value: req.value,
    secret: secret ? 1 : 0,
    description: description ?? null,
    createdAt,
    updatedAt: now,
  });
  logger.info(`Upserted coordinator config: ${req.key}`);
  return {
    key: req.key,
    value: req.value,
    secret,
    description: description ?? null,
    createdAt,
    updatedAt: now,
  };
}

export function deleteCoordinatorConfig(key: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM coordinator_config WHERE key = ?')
    .run(key);
  if (result.changes > 0) {
    logger.info(`Deleted coordinator config: ${key}`);
  }
  return result.changes > 0;
}