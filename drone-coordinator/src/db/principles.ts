import { randomUUID } from 'crypto';
import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import { getRow, deleteRow } from 'drone-swarm-common';

export interface PrincipleRow {
  id: string;
  targetType: string;
  targetId: string;
  principle: string;
  source: string | null;
  createdAt: string;
  scope: string;
}

export function createPrinciple(
  targetType: string,
  targetId: string,
  principle: string,
  source?: string,
  scope: string = 'coordinator'
): PrincipleRow {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const row: PrincipleRow = {
    id,
    targetType,
    targetId,
    principle,
    source: source ?? null,
    createdAt,
    scope,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO principles (id, targetType, targetId, principle, source, createdAt, scope)
    VALUES (@id, @targetType, @targetId, @principle, @source, @createdAt, @scope)
  `);
  stmt.run(row);
  logger.info(`Created principle for ${targetType} "${targetId}"`);
  return row;
}

export function listPrinciples(
  targetType?: string,
  targetId?: string
): PrincipleRow[] {
  let sql = 'SELECT * FROM principles WHERE 1=1';
  const params: string[] = [];

  if (targetType) {
    sql += ' AND targetType = ?';
    params.push(targetType);
  }
  if (targetId) {
    sql += ' AND targetId = ?';
    params.push(targetId);
  }

  sql += ' ORDER BY createdAt DESC';
  const stmt = getDatabase().prepare(sql);
  return (
    params.length > 0 ? stmt.all(...params) : stmt.all()
  ) as PrincipleRow[];
}

export function getPrinciple(id: string): PrincipleRow | undefined {
  return getRow<PrincipleRow>(getDatabase, 'principles', id);
}

export function deletePrinciple(id: string): boolean {
  const result = deleteRow(getDatabase, 'principles', id);
  logger.info(`Deleted principle: ${id}`);
  return result;
}
