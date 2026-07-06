import { randomUUID } from 'crypto';
import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { EventLog, EventType, CreateEventLogRequest } from '../types.js';

function rowToEventLog(row: {
  id: string;
  event_type: string;
  agent_id: string | null;
  target_id: string | null;
  target_type: string | null;
  metadata: string | null;
  timestamp: number;
}): EventLog {
  return {
    id: row.id,
    eventType: row.event_type as EventType,
    agentId: row.agent_id,
    targetId: row.target_id,
    targetType: row.target_type,
    metadata: row.metadata,
    timestamp: row.timestamp,
  };
}

export function createEventLog(req: CreateEventLogRequest): EventLog {
  const now = Date.now();
  const id = randomUUID();
  const eventLog: EventLog = {
    id,
    eventType: req.eventType,
    agentId: req.agentId ?? null,
    targetId: req.targetId ?? null,
    targetType: req.targetType ?? null,
    metadata: req.metadata ? JSON.stringify(req.metadata) : null,
    timestamp: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO event_log (id, event_type, agent_id, target_id, target_type, metadata, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    eventLog.eventType,
    eventLog.agentId,
    eventLog.targetId,
    eventLog.targetType,
    eventLog.metadata,
    eventLog.timestamp
  );
  return eventLog;
}

export function getEventLog(id: string): EventLog | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM event_log WHERE id = ?');
  const row = stmt.get(id) as
    | {
        id: string;
        event_type: string;
        agent_id: string | null;
        target_id: string | null;
        target_type: string | null;
        metadata: string | null;
        timestamp: number;
      }
    | undefined;
  if (!row) return undefined;
  return rowToEventLog(row);
}

export interface ListEventLogsOptions {
  agentId?: string;
  eventType?: EventType;
  since?: number;
  limit?: number;
}

export function listEventLogs(options: ListEventLogsOptions = {}): EventLog[] {
  const { agentId, eventType, since, limit = 100 } = options;

  let sql = 'SELECT * FROM event_log WHERE 1=1';
  const params: (string | number)[] = [];

  if (agentId) {
    sql += ' AND agent_id = ?';
    params.push(agentId);
  }

  if (eventType) {
    sql += ' AND event_type = ?';
    params.push(eventType);
  }

  if (since) {
    sql += ' AND timestamp >= ?';
    params.push(since);
  }

  sql += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const stmt = getDatabase().prepare(sql);
  const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as Array<{
    id: string;
    event_type: string;
    agent_id: string | null;
    target_id: string | null;
    target_type: string | null;
    metadata: string | null;
    timestamp: number;
  }>;

  return rows.map(rowToEventLog);
}

export function cleanupOldEventLogs(maxAgeDays: number = 30): number {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const stmt = getDatabase().prepare(
    'DELETE FROM event_log WHERE timestamp < ?'
  );
  const result = stmt.run(cutoff);
  if (result.changes > 0) {
    logger.info(`Cleaned up ${result.changes} old event logs`);
  }
  return result.changes;
}
