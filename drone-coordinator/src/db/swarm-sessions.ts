import { getDatabase } from './init.js';
import { logger } from '../logger.js';

export interface SwarmSession {
  id: string;
  personaId: string | null;
  beaconId: string;
  createdAt: number;
  updatedAt: number;
  status: string;
}

export interface SwarmEvent {
  id: string;
  sessionId: string;
  correlationId: string | null;
  type: string;
  payload: string | null;
  metadata: string | null;
  createdAt: number;
}

export function createSwarmSession(
  id: string,
  personaId: string | null,
  beaconId: string
): SwarmSession {
  const now = Date.now();
  const session: SwarmSession = {
    id,
    personaId,
    beaconId,
    createdAt: now,
    updatedAt: now,
    status: 'active',
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO swarm_sessions (id, persona_id, beacon_id, createdAt, updatedAt, status)
    VALUES (@id, @personaId, @beaconId, @createdAt, @updatedAt, @status)
  `);

  stmt.run({
    id: session.id,
    personaId: session.personaId,
    beaconId: session.beaconId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
  });

  logger.info(`Created swarm session: ${session.id}`);
  return session;
}

export function getSwarmSession(id: string): SwarmSession | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM swarm_sessions WHERE id = ?'
  );
  const row = stmt.get(id) as
    | {
        id: string;
        persona_id: string | null;
        beacon_id: string;
        createdAt: number;
        updatedAt: number;
        status: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    personaId: row.persona_id,
    beaconId: row.beacon_id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
  };
}

export function listSwarmSessions(options?: {
  status?: string;
  sortBy?: string;
  sortDirection?: string;
  limit?: number;
  offset?: number;
}): SwarmSession[] {
  let query = 'SELECT * FROM swarm_sessions WHERE 1=1';
  const params: unknown[] = [];

  if (options?.status) {
    query += ' AND status = ?';
    params.push(options.status);
  }

  const sortCol = options?.sortBy === 'updatedAt' ? 'updatedAt' : 'createdAt';
  const sortDir = options?.sortDirection === 'ASC' ? 'ASC' : 'DESC';
  query += ` ORDER BY ${sortCol} ${sortDir}`;

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = getDatabase().prepare(query);
  const rows = stmt.all(...params) as Array<{
    id: string;
    persona_id: string | null;
    beacon_id: string;
    createdAt: number;
    updatedAt: number;
    status: string;
  }>;
  return rows.map(row => ({
    id: row.id,
    personaId: row.persona_id,
    beaconId: row.beacon_id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
  }));
}

export function updateSwarmSessionStatus(
  id: string,
  status: string
): SwarmSession | undefined {
  const existing = getSwarmSession(id);
  if (!existing) return undefined;

  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE swarm_sessions SET status = @status, updatedAt = @updatedAt WHERE id = @id
  `);
  stmt.run({ id, status, updatedAt: now });

  return { ...existing, status, updatedAt: now };
}

export function transitionSessionStatus(
  id: string,
  fromStatus: string | string[],
  toStatus: string
): SwarmSession | { error: string } {
  const session = getSwarmSession(id);
  if (!session) return { error: 'Session not found' };

  const allowedFrom = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
  if (!allowedFrom.includes(session.status)) {
    return {
      error: `Cannot transition from '${session.status}' to '${toStatus}'`,
    };
  }

  const now = Date.now();
  const stmt = getDatabase().prepare(
    'UPDATE swarm_sessions SET status = @status, updatedAt = @updatedAt WHERE id = @id'
  );
  stmt.run({ id, status: toStatus, updatedAt: now });

  return { ...session, status: toStatus, updatedAt: now };
}

export function getStaleSessions(thresholdMs: number): SwarmSession[] {
  const cutoff = Date.now() - thresholdMs;
  const stmt = getDatabase().prepare(
    "SELECT * FROM swarm_sessions WHERE status = 'active' AND updatedAt < ?"
  );
  const rows = stmt.all(cutoff) as Array<{
    id: string;
    persona_id: string | null;
    beacon_id: string;
    createdAt: number;
    updatedAt: number;
    status: string;
  }>;
  return rows.map(row => ({
    id: row.id,
    personaId: row.persona_id,
    beaconId: row.beacon_id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
  }));
}

export function createSwarmEvent(event: SwarmEvent): SwarmEvent {
  const stmt = getDatabase().prepare(`
    INSERT INTO swarm_events (id, sessionId, correlationId, type, payload, metadata, createdAt)
    VALUES (@id, @sessionId, @correlationId, @type, @payload, @metadata, @createdAt)
  `);

  stmt.run({
    id: event.id,
    sessionId: event.sessionId,
    correlationId: event.correlationId,
    type: event.type,
    payload: event.payload,
    metadata: event.metadata,
    createdAt: event.createdAt,
  });

  return event;
}

export function getSwarmEvents(
  sessionId: string,
  options?: { correlationId?: string; limit?: number; offset?: number }
): SwarmEvent[] {
  let query = 'SELECT * FROM swarm_events WHERE sessionId = ?';
  const params: unknown[] = [sessionId];

  if (options?.correlationId) {
    query += ' AND correlationId = ?';
    params.push(options.correlationId);
  }

  query += ' ORDER BY createdAt ASC';

  if (options?.limit) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }

  const stmt = getDatabase().prepare(query);
  return stmt.all(...params) as SwarmEvent[];
}

export function getLatestSwarmEvents(
  sessionId: string,
  limit: number = 10
): SwarmEvent[] {
  const stmt = getDatabase().prepare(`
    SELECT * FROM swarm_events WHERE sessionId = ? ORDER BY createdAt DESC LIMIT ?
  `);
  return stmt.all(sessionId, limit) as SwarmEvent[];
}

export function searchSwarmEvents(query: string): SwarmEvent[] {
  const stmt = getDatabase().prepare(`
    SELECT se.* FROM swarm_events se
    JOIN swarm_events_fts fts ON se.id = fts.rowid
    WHERE swarm_events_fts MATCH ?
    ORDER BY se.createdAt ASC
  `);
  return stmt.all(query) as SwarmEvent[];
}
