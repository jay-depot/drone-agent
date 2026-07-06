import { getDatabase } from './init.js';
import { logger } from '../logger.js';

export interface AgentLocation {
  agentId: string;
  beaconId: string;
  personaId: string | null;
  connectedAt: number;
  lastHeartbeat: number;
}

export function registerAgentLocation(
  agentId: string,
  beaconId: string,
  personaId?: string | null
): AgentLocation {
  const now = Date.now();
  const location: AgentLocation = {
    agentId,
    beaconId,
    personaId: personaId ?? null,
    connectedAt: now,
    lastHeartbeat: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO agent_locations (agent_id, beacon_id, persona_id, connected_at, last_heartbeat)
    VALUES (@agentId, @beaconId, @personaId, @connectedAt, @lastHeartbeat)
  `);

  stmt.run(location);
  logger.info(`Registered agent location: ${agentId} -> beacon ${beaconId}`);
  return location;
}

export function getAgentLocation(agentId: string): AgentLocation | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM agent_locations WHERE agent_id = ?'
  );
  const row = stmt.get(agentId) as
    | {
        agent_id: string;
        beacon_id: string;
        persona_id: string | null;
        connected_at: number;
        last_heartbeat: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    agentId: row.agent_id,
    beaconId: row.beacon_id,
    personaId: row.persona_id,
    connectedAt: row.connected_at,
    lastHeartbeat: row.last_heartbeat,
  };
}

export function updateAgentLocationHeartbeat(
  agentId: string
): AgentLocation | undefined {
  const existing = getAgentLocation(agentId);
  if (!existing) return undefined;

  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE agent_locations SET last_heartbeat = ? WHERE agent_id = ?
  `);
  stmt.run(now, agentId);

  return { ...existing, lastHeartbeat: now };
}

export function unregisterAgentLocation(agentId: string): boolean {
  const stmt = getDatabase().prepare(
    'DELETE FROM agent_locations WHERE agent_id = ?'
  );
  const result = stmt.run(agentId);
  if (result.changes > 0) {
    logger.info(`Unregistered agent location: ${agentId}`);
  }
  return result.changes > 0;
}

export function listAgentLocationsByBeacon(beaconId: string): AgentLocation[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM agent_locations WHERE beacon_id = ? ORDER BY connected_at DESC'
  );
  const rows = stmt.all(beaconId) as Array<{
    agent_id: string;
    beacon_id: string;
    persona_id: string | null;
    connected_at: number;
    last_heartbeat: number;
  }>;
  return rows.map(row => ({
    agentId: row.agent_id,
    beaconId: row.beacon_id,
    personaId: row.persona_id,
    connectedAt: row.connected_at,
    lastHeartbeat: row.last_heartbeat,
  }));
}

export function listAllAgentLocations(): AgentLocation[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM agent_locations ORDER BY connected_at DESC'
  );
  const rows = stmt.all() as Array<{
    agent_id: string;
    beacon_id: string;
    persona_id: string | null;
    connected_at: number;
    last_heartbeat: number;
  }>;
  return rows.map(row => ({
    agentId: row.agent_id,
    beaconId: row.beacon_id,
    personaId: row.persona_id,
    connectedAt: row.connected_at,
    lastHeartbeat: row.last_heartbeat,
  }));
}
