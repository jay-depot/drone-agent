import { randomUUID } from 'crypto';
import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type {
  Memory,
  CreateMemoryRequest,
  UpdateMemoryRequest,
} from '../types.js';
import { getRow, deleteRow } from 'drone-swarm-common';

export function createMemory(
  req: CreateMemoryRequest,
  namespace: string = 'default'
): Memory {
  const now = Date.now();
  const ttl = req.ttlSeconds ? now + req.ttlSeconds * 1000 : null;
  // Convert value to string if it's an object
  const value =
    typeof req.value === 'object' ? JSON.stringify(req.value) : req.value;
  const memory: Memory = {
    id: randomUUID(),
    key: req.key,
    value: value,
    namespace: req.namespace ?? namespace,
    ttl,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO memory (id, key, value, namespace, ttl, createdAt, updatedAt)
    VALUES (@id, @key, @value, @namespace, @ttl, @createdAt, @updatedAt)
  `);

  stmt.run(memory);
  logger.info(`Created memory: ${memory.key} (${memory.id})`);
  return memory;
}

export function getMemory(id: string): Memory | undefined {
  return getRow<Memory>(getDatabase, 'memory', id);
}

export function getMemoryByKey(
  key: string,
  namespace: string = 'default'
): Memory | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM memory WHERE key = ? AND namespace = ?'
  );
  return stmt.get(key, namespace) as Memory | undefined;
}

export function listMemories(
  namespace?: string,
  includeExpired: boolean = false
): Memory[] {
  let sql = 'SELECT * FROM memory';
  const params: (string | number)[] = [];

  if (namespace) {
    sql += ' WHERE namespace = ?';
    params.push(namespace);
  }

  if (!includeExpired) {
    sql += namespace ? ' AND' : ' WHERE';
    sql += ' (ttl IS NULL OR ttl > ?)';
    params.push(Date.now());
  }

  sql += ' ORDER BY key';

  const stmt = getDatabase().prepare(sql);
  return (params.length > 0 ? stmt.all(...params) : stmt.all()) as Memory[];
}

export function updateMemory(
  id: string,
  req: UpdateMemoryRequest
): Memory | undefined {
  const existing = getMemory(id);
  if (!existing) return undefined;

  const ttl =
    req.ttlSeconds !== undefined
      ? req.ttlSeconds > 0
        ? Date.now() + req.ttlSeconds * 1000
        : null
      : existing.ttl;

  const updated: Memory = {
    ...existing,
    key: req.key ?? existing.key,
    value:
      (typeof req.value === 'object' ? JSON.stringify(req.value) : req.value) ??
      existing.value,
    ttl,
    updatedAt: Date.now(),
  };

  const stmt = getDatabase().prepare(`
    UPDATE memory
    SET key = @key, value = @value, ttl = @ttl, updatedAt = @updatedAt
    WHERE id = @id
  `);

  stmt.run(updated);
  logger.info(`Updated memory: ${id}`);
  return updated;
}

export function deleteMemory(id: string): boolean {
  const result = deleteRow(getDatabase, 'memory', id);
  logger.info(`Deleted memory: ${id}`);
  return result;
}

export function cleanupExpiredMemories(): number {
  const now = Date.now();
  const stmt = getDatabase().prepare(
    'DELETE FROM memory WHERE ttl IS NOT NULL AND ttl <= ?'
  );
  const result = stmt.run(now);
  if (result.changes > 0) {
    logger.info(`Cleaned up ${result.changes} expired memories`);
  }
  return result.changes;
}

// Helper to check if memory is expired
export function isMemoryExpired(memory: Memory): boolean {
  return memory.ttl !== null && memory.ttl <= Date.now();
}
