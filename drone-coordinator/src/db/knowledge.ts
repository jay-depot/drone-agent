import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { Knowledge, CreateKnowledgeRequest } from '../types.js';
import { getRow, deleteRow } from 'drone-swarm-common';

function rowToKnowledge(row: {
  id: string;
  type: string;
  key: string;
  value: string;
  source_beacon_id: string | null;
  source_agent_id: string | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}): Knowledge {
  return {
    id: row.id,
    type: row.type as Knowledge['type'],
    key: row.key,
    value: row.value,
    sourceBeaconId: row.source_beacon_id,
    sourceAgentId: row.source_agent_id,
    confidence: row.confidence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createKnowledge(req: CreateKnowledgeRequest): Knowledge {
  const now = Date.now();
  const knowledge: Knowledge = {
    id: req.id,
    type: req.type,
    key: req.key,
    value: req.value,
    sourceBeaconId: req.sourceBeaconId ?? null,
    sourceAgentId: req.sourceAgentId ?? null,
    confidence: req.confidence ?? 1.0,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO knowledge (id, type, key, value, source_beacon_id, source_agent_id, confidence, createdAt, updatedAt)
    VALUES (@id, @type, @key, @value, @sourceBeaconId, @sourceAgentId, @confidence, @createdAt, @updatedAt)
  `);

  stmt.run({
    id: knowledge.id,
    type: knowledge.type,
    key: knowledge.key,
    value: knowledge.value,
    sourceBeaconId: knowledge.sourceBeaconId,
    sourceAgentId: knowledge.sourceAgentId,
    confidence: knowledge.confidence,
    createdAt: knowledge.createdAt,
    updatedAt: knowledge.updatedAt,
  });

  logger.info(
    `Created knowledge: ${knowledge.id} (${knowledge.type}:${knowledge.key})`
  );
  return knowledge;
}

export function getKnowledge(id: string): Knowledge | undefined {
  return getRow<Knowledge>(getDatabase, 'knowledge', id);
}

export function listKnowledge(type?: string): Knowledge[] {
  let stmt;
  if (type) {
    stmt = getDatabase().prepare(
      'SELECT * FROM knowledge WHERE type = ? ORDER BY key'
    );
    return (
      stmt.all(type) as Array<{
        id: string;
        type: string;
        key: string;
        value: string;
        source_beacon_id: string | null;
        source_agent_id: string | null;
        confidence: number;
        createdAt: number;
        updatedAt: number;
      }>
    ).map(rowToKnowledge);
  }
  stmt = getDatabase().prepare('SELECT * FROM knowledge ORDER BY type, key');
  return (
    stmt.all() as Array<{
      id: string;
      type: string;
      key: string;
      value: string;
      source_beacon_id: string | null;
      source_agent_id: string | null;
      confidence: number;
      createdAt: number;
      updatedAt: number;
    }>
  ).map(rowToKnowledge);
}

export function updateKnowledge(
  id: string,
  req: { type?: string; key?: string; value?: string; confidence?: number }
): Knowledge | undefined {
  const existing = getKnowledge(id);
  if (!existing) return undefined;

  const updated: Knowledge = {
    ...existing,
    type: (req.type ?? existing.type) as Knowledge['type'],
    key: req.key ?? existing.key,
    value: req.value ?? existing.value,
    confidence: req.confidence ?? existing.confidence,
    updatedAt: Date.now(),
  };

  const stmt = getDatabase().prepare(`
    UPDATE knowledge 
    SET type = @type, key = @key, value = @value, confidence = @confidence, updatedAt = @updatedAt
    WHERE id = @id
  `);

  stmt.run({
    id: updated.id,
    type: updated.type,
    key: updated.key,
    value: updated.value,
    confidence: updated.confidence,
    updatedAt: updated.updatedAt,
  });

  logger.info(`Updated knowledge: ${id}`);
  return updated;
}

export function deleteKnowledge(id: string): boolean {
  const result = deleteRow(getDatabase, 'knowledge', id);
  logger.info(`Deleted knowledge: ${id}`);
  return result;
}

export function searchKnowledge(query: string, type?: string): Knowledge[] {
  let stmt;
  const searchPattern = `%${query}%`;

  if (type) {
    stmt = getDatabase().prepare(`
      SELECT * FROM knowledge 
      WHERE type = ? AND (key LIKE ? OR value LIKE ?)
      ORDER BY confidence DESC
    `);
    return (
      stmt.all(type, searchPattern, searchPattern) as Array<{
        id: string;
        type: string;
        key: string;
        value: string;
        source_beacon_id: string | null;
        source_agent_id: string | null;
        confidence: number;
        createdAt: number;
        updatedAt: number;
      }>
    ).map(rowToKnowledge);
  }

  stmt = getDatabase().prepare(`
    SELECT * FROM knowledge 
    WHERE key LIKE ? OR value LIKE ?
    ORDER BY confidence DESC
  `);
  return (
    stmt.all(searchPattern, searchPattern) as Array<{
      id: string;
      type: string;
      key: string;
      value: string;
      source_beacon_id: string | null;
      source_agent_id: string | null;
      confidence: number;
      createdAt: number;
      updatedAt: number;
    }>
  ).map(rowToKnowledge);
}

export function upsertKnowledge(req: CreateKnowledgeRequest): Knowledge {
  // Check if knowledge with same type+key already exists
  const stmt = getDatabase().prepare(
    'SELECT * FROM knowledge WHERE type = ? AND key = ?'
  );
  const existing = stmt.get(req.type, req.key) as
    | {
        id: string;
        type: string;
        key: string;
        value: string;
        source_beacon_id: string | null;
        source_agent_id: string | null;
        confidence: number;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;

  if (existing) {
    // Conflict resolution: keep highest confidence or latest timestamp
    const newConfidence = req.confidence ?? 1.0;
    if (newConfidence > existing.confidence) {
      // New knowledge has higher confidence, update
      return updateKnowledge(existing.id, {
        value: req.value,
        confidence: newConfidence,
      })!;
    }
    // Keep existing (higher or equal confidence)
    return rowToKnowledge(existing);
  }

  // No existing entry, create new
  return createKnowledge(req);
}
