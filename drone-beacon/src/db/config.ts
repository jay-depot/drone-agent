import { getDatabase } from './init.js';
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

export function getBeaconConfig(key: string): BeaconConfigEntry | null {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_config WHERE key = ?'
  );
  return stmt.get(key) as BeaconConfigEntry | null;
}

export function listBeaconConfig(): BeaconConfigEntry[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_config ORDER BY key'
  );
  return stmt.all() as BeaconConfigEntry[];
}

export function updateBeaconConfig(
  key: string,
  value: string
): BeaconConfigEntry | null {
  const existing = getBeaconConfig(key);
  if (!existing) {
    return null;
  }
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_config SET value = ?, updatedAt = ? WHERE key = ?
  `);
  stmt.run(value, now, key);
  logger.info(`Updated beacon config: ${key}`);
  return getBeaconConfig(key);
}

export function deleteBeaconConfig(key: string): boolean {
  const stmt = getDatabase().prepare('DELETE FROM beacon_config WHERE key = ?');
  const result = stmt.run(key);
  logger.info(`Deleted beacon config: ${key}`);
  return result.changes > 0;
}
