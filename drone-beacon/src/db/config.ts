import { getDatabase } from './init.js';
import type { CoordinatorConfigEntry } from 'drone-core';
import { logger } from '../logger.js';

export interface BeaconConfigEntry {
  key: string;
  value: string; // JSON string
  scope: 'local' | 'swarm';
  createdAt: number;
  updatedAt: number;
}

export interface CreateConfigRequest {
  key: string;
  value: string; // JSON string
  scope?: 'local' | 'swarm'; // default: "local"
}

interface BeaconConfigRow {
  key: string;
  value: string;
  scope: 'local' | 'swarm';
  createdAt: number;
  updatedAt: number;
}

function rowToEntry(row: BeaconConfigRow): BeaconConfigEntry {
  return {
    key: row.key,
    value: row.value,
    scope: row.scope,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createBeaconConfig(
  req: CreateConfigRequest
): BeaconConfigEntry {
  const now = Date.now();
  const scope = req.scope ?? 'local';
  const stmt = getDatabase().prepare(`
    INSERT INTO beacon_config (key, value, scope, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(req.key, req.value, scope, now, now);
  logger.info(`Created beacon config: ${req.key} (scope: ${scope})`);
  return {
    key: req.key,
    value: req.value,
    scope,
    createdAt: now,
    updatedAt: now,
  };
}

export function getBeaconConfig(
  key: string,
  scope: 'local' | 'swarm' = 'local'
): BeaconConfigEntry | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_config WHERE key = ? AND scope = ?'
  );
  const row = stmt.get(key, scope) as BeaconConfigRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

export function listBeaconConfig(
  scope?: 'local' | 'swarm'
): BeaconConfigEntry[] {
  if (scope) {
    const stmt = getDatabase().prepare(
      'SELECT * FROM beacon_config WHERE scope = ? ORDER BY key'
    );
    const rows = stmt.all(scope) as BeaconConfigRow[];
    return rows.map(rowToEntry);
  }
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_config ORDER BY key'
  );
  const rows = stmt.all() as BeaconConfigRow[];
  return rows.map(rowToEntry);
}

/**
 * Merged view of all beacon config: one row per key, beacon-local wins over
 * the coordinator-pushed swarm scope. The agent injector loops over this —
 * a single row per key avoids last-write-wins ambiguity.
 */
export function listMergedConfig(): BeaconConfigEntry[] {
  const stmt = getDatabase().prepare(`
    SELECT key, value, scope, createdAt, updatedAt
    FROM beacon_config
    ORDER BY CASE scope WHEN 'local' THEN 0 ELSE 1 END, createdAt
  `);
  const rows = stmt.all() as BeaconConfigRow[];
  const merged = new Map<string, BeaconConfigEntry>();
  for (const row of rows) {
    // First occurrence of a key wins (local rows sort first).
    if (!merged.has(row.key)) {
      merged.set(row.key, rowToEntry(row));
    }
  }
  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Replace all coordinator-pushed (swarm-scoped) config entries with the given
 * coordinator entries. Local rows are untouched and keep precedence in the
 * merged view.
 */
export function replaceSwarmConfig(entries: CoordinatorConfigEntry[]): void {
  const db = getDatabase();
  db.prepare("DELETE FROM beacon_config WHERE scope = 'swarm'").run();
  const insert = db.prepare(`
    INSERT INTO beacon_config (key, value, scope, createdAt, updatedAt)
    VALUES (?, ?, 'swarm', ?, ?)
  `);
  const now = Date.now();
  for (const entry of entries) {
    insert.run(
      entry.key,
      entry.value,
      entry.updatedAt || now,
      entry.updatedAt || now
    );
  }
  logger.info(`Replaced swarm config with ${entries.length} entries`);
}

export function updateBeaconConfig(
  key: string,
  value: string,
  scope: 'local' | 'swarm' = 'local'
): BeaconConfigEntry | null {
  const existing = getBeaconConfig(key, scope);
  if (!existing) {
    return null;
  }
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_config SET value = ?, updatedAt = ? WHERE key = ? AND scope = ?
  `);
  stmt.run(value, now, key, scope);
  logger.info(`Updated beacon config: ${key} (scope: ${scope})`);
  return getBeaconConfig(key, scope) ?? null;
}

export function deleteBeaconConfig(
  key: string,
  scope: 'local' | 'swarm' = 'local'
): boolean {
  const stmt = getDatabase().prepare(
    'DELETE FROM beacon_config WHERE key = ? AND scope = ?'
  );
  const result = stmt.run(key, scope);
  logger.info(`Deleted beacon config: ${key} (scope: ${scope})`);
  return result.changes > 0;
}
