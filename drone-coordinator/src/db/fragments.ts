import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { DroneSwarmFragment } from 'drone-core';

export type CoordinatorFragmentRow = DroneSwarmFragment;

function rowToFragment(row: Record<string, unknown>): CoordinatorFragmentRow {
  return {
    id: row.id as string,
    target: row.target as string,
    content: row.content as string,
    phase: row.phase as CoordinatorFragmentRow['phase'],
    scope: 'coordinator',
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    expiresAt: (row.expiresAt as number | null) ?? null,
  };
}

/**
 * Insert or update a coordinator-scoped fragment, preserving `createdAt`
 * across updates. `createdAt`/`updatedAt` may be omitted; the current time is
 * stamped. Rows are always coordinator-scoped.
 */
export function upsertFragment(
  fragment: Omit<
    DroneSwarmFragment,
    'createdAt' | 'updatedAt' | 'scope'
  > & {
    createdAt?: number;
    scope?: DroneSwarmFragment['scope'];
  }
): DroneSwarmFragment {
  const now = Date.now();
  const existing = getFragment(fragment.id, fragment.target);
  const row: DroneSwarmFragment = {
    ...fragment,
    scope: 'coordinator',
    createdAt: existing?.createdAt ?? fragment.createdAt ?? now,
    updatedAt: now,
  };
  const stmt = getDatabase().prepare(`
    INSERT INTO fragments (id, target, content, phase, scope, createdAt, updatedAt, expiresAt)
    VALUES (@id, @target, @content, @phase, @scope, @createdAt, @updatedAt, @expiresAt)
    ON CONFLICT(id, target) DO UPDATE SET
      content = excluded.content,
      phase = excluded.phase,
      scope = excluded.scope,
      updatedAt = excluded.updatedAt,
      expiresAt = excluded.expiresAt
  `);
  stmt.run(row);
  logger.info(`Upserted fragment: ${row.id} -> ${row.target}`);
  return row;
}

export function getFragment(
  id: string,
  target: string
): DroneSwarmFragment | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM fragments WHERE id = ? AND target = ?'
  );
  const row = stmt.get(id, target) as Record<string, unknown> | undefined;
  return row ? rowToFragment(row) : undefined;
}

export function listFragments(
  options: { target?: string } = {}
): DroneSwarmFragment[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (options.target !== undefined) {
    clauses.push('target = ?');
    params.push(options.target);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const stmt = getDatabase().prepare(`SELECT * FROM fragments${where}`);
  const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as Record<
    string,
    unknown
  >[];
  return rows.map(rowToFragment);
}

export function deleteFragment(id: string, target: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM fragments WHERE id = ? AND target = ?')
    .run(id, target);
  if (result.changes > 0) {
    logger.info(`Deleted fragment: ${id} -> ${target}`);
  }
  return result.changes > 0;
}
