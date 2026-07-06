import { randomUUID } from 'crypto';
import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import { getRow, deleteRow } from 'drone-swarm-common';

export interface InsightRow {
  id: string;
  targetType: string;
  targetId: string;
  insight: string;
  timestamp: string;
  scope: string;
}

export function createInsight(
  targetType: string,
  targetId: string,
  insight: string,
  scope: string = 'local'
): InsightRow {
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const row: InsightRow = {
    id,
    targetType,
    targetId,
    insight,
    timestamp,
    scope,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO insights (id, targetType, targetId, insight, timestamp, scope)
    VALUES (@id, @targetType, @targetId, @insight, @timestamp, @scope)
  `);
  stmt.run(row);
  logger.info(`Created insight for ${targetType} "${targetId}"`);
  return row;
}

export function listInsights(
  targetType?: string,
  targetId?: string
): InsightRow[] {
  let sql = 'SELECT * FROM insights WHERE 1=1';
  const params: string[] = [];

  if (targetType) {
    sql += ' AND targetType = ?';
    params.push(targetType);
  }
  if (targetId) {
    sql += ' AND targetId = ?';
    params.push(targetId);
  }

  sql += ' ORDER BY timestamp DESC';
  const stmt = getDatabase().prepare(sql);
  return (params.length > 0 ? stmt.all(...params) : stmt.all()) as InsightRow[];
}

export function getInsight(id: string): InsightRow | undefined {
  return getRow<InsightRow>(getDatabase, 'insights', id);
}

export function deleteInsight(id: string): boolean {
  const result = deleteRow(getDatabase, 'insights', id);
  logger.info(`Deleted insight: ${id}`);
  return result;
}
