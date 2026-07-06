import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { BeaconSession, CreateSessionRequest } from '../types.js';

function rowToBeaconSession(row: {
  id: string;
  beacon_id: string;
  agent_id: string;
  persona_id: string | null;
  connected_at: number;
  disconnected_at: number | null;
  duration_ms: number | null;
  createdAt: number;
  updatedAt: number;
}): BeaconSession {
  return {
    id: row.id,
    beaconId: row.beacon_id,
    agentId: row.agent_id,
    personaId: row.persona_id,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    durationMs: row.duration_ms,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createBeaconSession(
  beaconId: string,
  req: CreateSessionRequest
): BeaconSession {
  const now = Date.now();
  const session: BeaconSession = {
    id: req.id,
    beaconId,
    agentId: req.agentId,
    personaId: req.personaId ?? null,
    connectedAt: now,
    disconnectedAt: null,
    durationMs: null,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO beacon_sessions (id, beacon_id, agent_id, persona_id, connected_at, disconnected_at, duration_ms, createdAt, updatedAt)
    VALUES (@id, @beaconId, @agentId, @personaId, @connectedAt, @disconnectedAt, @durationMs, @createdAt, @updatedAt)
  `);

  stmt.run({
    id: session.id,
    beaconId: session.beaconId,
    agentId: session.agentId,
    personaId: session.personaId,
    connectedAt: session.connectedAt,
    disconnectedAt: session.disconnectedAt,
    durationMs: session.durationMs,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  });

  logger.info(
    `Created beacon session: ${session.id} for agent ${session.agentId}`
  );
  return session;
}

export function getBeaconSession(
  beaconId: string,
  agentId: string
): BeaconSession | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_sessions WHERE beacon_id = ? AND agent_id = ? AND disconnected_at IS NULL'
  );
  const row = stmt.get(beaconId, agentId) as
    | {
        id: string;
        beacon_id: string;
        agent_id: string;
        persona_id: string | null;
        connected_at: number;
        disconnected_at: number | null;
        duration_ms: number | null;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;
  if (!row) return undefined;
  return rowToBeaconSession(row);
}

export function listBeaconSessions(beaconId: string): BeaconSession[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_sessions WHERE beacon_id = ? ORDER BY connected_at DESC'
  );
  const rows = stmt.all(beaconId) as Array<{
    id: string;
    beacon_id: string;
    agent_id: string;
    persona_id: string | null;
    connected_at: number;
    disconnected_at: number | null;
    duration_ms: number | null;
    createdAt: number;
    updatedAt: number;
  }>;
  return rows.map(rowToBeaconSession);
}

export function endBeaconSession(
  beaconId: string,
  agentId: string,
  disconnectedAt: number,
  durationMs: number
): BeaconSession | undefined {
  const existing = getBeaconSession(beaconId, agentId);
  if (!existing) return undefined;

  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_sessions 
    SET disconnected_at = ?, duration_ms = ?, updatedAt = ?
    WHERE beacon_id = ? AND agent_id = ? AND disconnected_at IS NULL
  `);

  stmt.run(disconnectedAt, durationMs, now, beaconId, agentId);
  logger.info(
    `Ended beacon session for agent ${agentId}, duration: ${durationMs}ms`
  );

  // Fetch and return updated session
  const stmt2 = getDatabase().prepare(
    'SELECT * FROM beacon_sessions WHERE beacon_id = ? AND agent_id = ?'
  );
  const row = stmt2.get(beaconId, agentId) as
    | {
        id: string;
        beacon_id: string;
        agent_id: string;
        persona_id: string | null;
        connected_at: number;
        disconnected_at: number | null;
        duration_ms: number | null;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;
  if (!row) return undefined;
  return rowToBeaconSession(row);
}

export function deleteBeaconSession(
  beaconId: string,
  agentId: string
): boolean {
  const stmt = getDatabase().prepare(
    'DELETE FROM beacon_sessions WHERE beacon_id = ? AND agent_id = ?'
  );
  const result = stmt.run(beaconId, agentId);
  logger.info(`Deleted beacon session for agent ${agentId}`);
  return result.changes > 0;
}
