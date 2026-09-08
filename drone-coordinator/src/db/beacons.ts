import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { Beacon, RegisterBeaconRequest } from '../types.js';
import { getRow, deleteRow } from 'drone-swarm-common';

interface BeaconRow {
  id: string;
  name: string;
  host: string;
  port: number;
  connectedAt: number;
  lastHeartbeat: number;
  spawn_roots: string | null;
  default_spawn_root: string | null;
}

function rowToBeacon(row: BeaconRow): Beacon {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    connectedAt: row.connectedAt,
    lastHeartbeat: row.lastHeartbeat,
    spawnRoots: row.spawn_roots
      ? (JSON.parse(row.spawn_roots) as string[])
      : undefined,
    defaultSpawnRoot: row.default_spawn_root ?? undefined,
  };
}

export function registerBeacon(req: RegisterBeaconRequest): Beacon {
  const now = Date.now();
  const existing = getBeacon(req.id);
  const beacon: Beacon = {
    id: req.id,
    name: req.name,
    host: req.host,
    port: req.port,
    connectedAt: now,
    lastHeartbeat: now,
    // Omitted fields preserve the existing row (merge-on-omit): a partial
    // re-registration must not erase the currently advertised roots.
    spawnRoots: req.spawnRoots ?? existing?.spawnRoots,
    defaultSpawnRoot: req.defaultSpawnRoot ?? existing?.defaultSpawnRoot,
  };

  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO beacons (id, name, host, port, connectedAt, lastHeartbeat, spawn_roots, default_spawn_root)
    VALUES (@id, @name, @host, @port, @connectedAt, @lastHeartbeat, @spawnRoots, @defaultSpawnRoot)
  `);

  stmt.run({
    ...beacon,
    spawnRoots: beacon.spawnRoots ? JSON.stringify(beacon.spawnRoots) : null,
  });
  logger.info(`Registered beacon: ${beacon.id}`);
  return beacon;
}

export function getBeacon(id: string): Beacon | undefined {
  const row = getRow<BeaconRow>(getDatabase, 'beacons', id);
  return row ? rowToBeacon(row) : undefined;
}

export function listBeacons(): Beacon[] {
  const stmt = getDatabase().prepare('SELECT * FROM beacons ORDER BY name');
  const rows = stmt.all() as BeaconRow[];
  return rows.map(rowToBeacon);
}

export function heartbeatBeacon(id: string): Beacon | undefined {
  const beacon = getBeacon(id);
  if (!beacon) return undefined;

  beacon.lastHeartbeat = Date.now();

  const stmt = getDatabase().prepare(`
    UPDATE beacons SET lastHeartbeat = @lastHeartbeat WHERE id = @id
  `);

  stmt.run(beacon);
  return beacon;
}

export function deleteBeacon(id: string): boolean {
  const result = deleteRow(getDatabase, 'beacons', id);
  logger.info(`Deleted beacon: ${id}`);
  return result;
}
