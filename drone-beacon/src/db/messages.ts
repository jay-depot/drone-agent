import { randomUUID } from 'crypto';
import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { AgentMessage } from '../types.js';

interface MessageRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  channel: string | null;
  body: string;
  delivered: number;
  created_at: number;
}

function rowToMessage(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    channel: row.channel,
    body: row.body,
    delivered: row.delivered === 1,
    createdAt: row.created_at,
  };
}

export function createMessage(
  fromAgentId: string,
  toAgentId: string | null,
  channel: string | null,
  body: string
): AgentMessage {
  const now = Date.now();
  const id = randomUUID();

  const stmt = getDatabase().prepare(`
    INSERT INTO messages (id, from_agent_id, to_agent_id, channel, body, delivered, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `);

  stmt.run(id, fromAgentId, toAgentId, channel, body, now);

  logger.info(`Created message ${id} from ${fromAgentId}`);
  return {
    id,
    fromAgentId,
    toAgentId,
    channel,
    body,
    delivered: false,
    createdAt: now,
  };
}

export function getMessage(id: string): AgentMessage | undefined {
  const stmt = getDatabase().prepare('SELECT * FROM messages WHERE id = ?');
  const row = stmt.get(id) as MessageRow | undefined;
  if (!row) return undefined;
  return rowToMessage(row);
}

export function listMessagesForAgent(
  agentId: string,
  unreadOnly: boolean = true
): AgentMessage[] {
  const sql = unreadOnly
    ? 'SELECT * FROM messages WHERE to_agent_id = ? AND delivered = 0 ORDER BY created_at DESC'
    : 'SELECT * FROM messages WHERE to_agent_id = ? ORDER BY created_at DESC';
  const stmt = getDatabase().prepare(sql);
  return (stmt.all(agentId) as MessageRow[]).map(rowToMessage);
}

export function listMessagesByChannel(channel: string): AgentMessage[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM messages WHERE channel = ? ORDER BY created_at DESC'
  );
  return (stmt.all(channel) as MessageRow[]).map(rowToMessage);
}

export function markMessageDelivered(id: string): boolean {
  const stmt = getDatabase().prepare(
    'UPDATE messages SET delivered = 1 WHERE id = ?'
  );
  const result = stmt.run(id);
  if (result.changes > 0) logger.info(`Marked message ${id} delivered`);
  return result.changes > 0;
}

export function cleanupOldMessages(maxAgeHours: number = 24): number {
  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  const stmt = getDatabase().prepare(
    'DELETE FROM messages WHERE delivered = 1 AND created_at < ?'
  );
  const result = stmt.run(cutoff);
  if (result.changes > 0)
    logger.info(`Cleaned up ${result.changes} old messages`);
  return result.changes;
}
