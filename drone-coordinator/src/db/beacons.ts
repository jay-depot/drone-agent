import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { Beacon, RegisterBeaconRequest } from '../types.js';
import { getRow, deleteRow } from 'drone-swarm-common';

export function registerBeacon(req: RegisterBeaconRequest): Beacon {
  const now = Date.now();
  const beacon: Beacon = {
    id: req.id,
    name: req.name,
    host: req.host,
    port: req.port,
    connectedAt: now,
    lastHeartbeat: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO beacons (id, name, host, port, connectedAt, lastHeartbeat)
    VALUES (@id, @name, @host, @port, @connectedAt, @lastHeartbeat)
  `);

  stmt.run(beacon);
  logger.info(`Registered beacon: ${beacon.id}`);
  return beacon;
}

export function getBeacon(id: string): Beacon | undefined {
  return getRow<Beacon>(getDatabase, 'beacons', id);
}

export function listBeacons(): Beacon[] {
  const stmt = getDatabase().prepare('SELECT * FROM beacons ORDER BY name');
  return stmt.all() as Beacon[];
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
