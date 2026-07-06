import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { Knowledge } from '../types.js';

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

export function cacheKnowledge(knowledge: Knowledge): void {
  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO knowledge_cache (id, type, key, value, source_beacon_id, source_agent_id, confidence, createdAt, updatedAt)
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
}

export function getCachedKnowledge(id: string): Knowledge | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM knowledge_cache WHERE id = ?'
  );
  const row = stmt.get(id) as
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
  if (!row) return undefined;
  return rowToKnowledge(row);
}

export function listCachedKnowledge(type?: string): Knowledge[] {
  let stmt;
  if (type) {
    stmt = getDatabase().prepare(
      'SELECT * FROM knowledge_cache WHERE type = ? ORDER BY key'
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
  stmt = getDatabase().prepare(
    'SELECT * FROM knowledge_cache ORDER BY type, key'
  );
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

export function clearKnowledgeCache(): void {
  getDatabase().prepare('DELETE FROM knowledge_cache').run();
  logger.info('Cleared knowledge cache');
}

export function replaceKnowledgeCache(knowledge: Knowledge[]): void {
  const db = getDatabase();
  const clear = db.prepare('DELETE FROM knowledge_cache');
  const insert = db.prepare(`
    INSERT INTO knowledge_cache (id, type, key, value, source_beacon_id, source_agent_id, confidence, createdAt, updatedAt)
    VALUES (@id, @type, @key, @value, @sourceBeaconId, @sourceAgentId, @confidence, @createdAt, @updatedAt)
  `);

  const transaction = db.transaction((items: Knowledge[]) => {
    clear.run();
    for (const k of items) {
      insert.run({
        id: k.id,
        type: k.type,
        key: k.key,
        value: k.value,
        sourceBeaconId: k.sourceBeaconId,
        sourceAgentId: k.sourceAgentId,
        confidence: k.confidence,
        createdAt: k.createdAt,
        updatedAt: k.updatedAt,
      });
    }
  });

  transaction(knowledge);
  logger.info(`Replaced knowledge cache with ${knowledge.length} entries`);
}
