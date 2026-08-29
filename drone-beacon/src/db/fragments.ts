import { createHash } from 'crypto';
import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type { DroneSwarmFragment } from 'drone-core';

export type FragmentRow = DroneSwarmFragment;

export type ListFragmentsOptions = {
  target?: string;
  scope?: string;
};

function rowToFragment(row: Record<string, unknown>): FragmentRow {
  return {
    id: row.id as string,
    target: row.target as string,
    content: row.content as string,
    phase: row.phase as FragmentRow['phase'],
    scope: row.scope as FragmentRow['scope'],
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    expiresAt: (row.expiresAt as number | null) ?? null,
  };
}

export function upsertFragment(
  fragment: Omit<FragmentRow, 'createdAt' | 'updatedAt'> & {
    createdAt?: number;
  }
): FragmentRow {
  const now = Date.now();
  const existing = getFragment(fragment.id, fragment.target);
  const row: FragmentRow = {
    ...fragment,
    createdAt: existing?.createdAt ?? now,
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
): FragmentRow | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM fragments WHERE id = ? AND target = ?'
  );
  const row = stmt.get(id, target) as Record<string, unknown> | undefined;
  return row ? rowToFragment(row) : undefined;
}

export function listFragments(
  options: ListFragmentsOptions = {}
): FragmentRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (options.target !== undefined) {
    clauses.push('target = ?');
    params.push(options.target);
  }
  if (options.scope !== undefined) {
    clauses.push('scope = ?');
    params.push(options.scope);
  }

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const stmt = getDatabase().prepare(`SELECT * FROM fragments${where}`);
  const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as Record<
    string,
    unknown
  >[];
  return rows.map(rowToFragment);
}

export function deleteFragment(
  id: string,
  target: string
): FragmentRow | undefined {
  const existing = getFragment(id, target);
  if (!existing) return undefined;
  const stmt = getDatabase().prepare(
    'DELETE FROM fragments WHERE id = ? AND target = ?'
  );
  stmt.run(id, target);
  logger.info(`Deleted fragment: ${id} -> ${target}`);
  return existing;
}

/**
 * Delete expired targeted rows. Returns the deleted rows so the caller can
 * push removal notices to connected agents.
 */
export function deleteExpiredFragments(
  now: number = Date.now()
): FragmentRow[] {
  const stmt = getDatabase().prepare(
    'DELETE FROM fragments WHERE expiresAt IS NOT NULL AND expiresAt <= ?'
  );
  const expired = listExpired(now);
  stmt.run(now);
  if (expired.length > 0) {
    logger.info(`Deleted ${expired.length} expired fragments`);
  }
  return expired;
}

function listExpired(now: number): FragmentRow[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM fragments WHERE expiresAt IS NOT NULL AND expiresAt <= ?'
  );
  const rows = stmt.all(now) as Record<string, unknown>[];
  return rows.map(rowToFragment);
}

/**
 * Wholesale-replace all coordinator-scoped rows with the given set (the
 * coordinator's current fragment table as seen by the last sync).
 */
export function replaceCoordinatorFragments(
  fragments: Array<
    Omit<FragmentRow, 'scope' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<FragmentRow, 'scope'>>
  >
): void {
  const db = getDatabase();
  const replace = db.transaction((rows: FragmentRow[]) => {
    db.prepare("DELETE FROM fragments WHERE scope = 'coordinator'").run();
    for (const row of rows) {
      db.prepare(
        `
        INSERT INTO fragments (id, target, content, phase, scope, createdAt, updatedAt, expiresAt)
        VALUES (@id, @target, @content, @phase, @scope, @createdAt, @updatedAt, @expiresAt)
        ON CONFLICT(id, target) DO UPDATE SET
          content = excluded.content,
          phase = excluded.phase,
          scope = excluded.scope,
          updatedAt = excluded.updatedAt,
          expiresAt = excluded.expiresAt
      `
      ).run(row);
    }
  });
  replace(
    fragments.map(f => ({
      ...f,
      scope: 'coordinator' as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }))
  );
}

function isExpired(fragment: FragmentRow, now: number): boolean {
  return fragment.expiresAt !== null && fragment.expiresAt <= now;
}

/**
 * TTL-filtered targeted fragments for one agent plus all broadcasts, with
 * coordinator-scoped rows shadowing local rows of the same id.
 */
export function listMergedForAgent(
  agentId: string,
  now: number = Date.now()
): FragmentRow[] {
  const all = listFragments();
  const live = all.filter(f => !isExpired(f, now));

  const targeted = live.filter(f => f.target === agentId);
  const broadcasts = live.filter(f => f.target === 'broadcast');

  const shadowed = new Map<string, FragmentRow>();
  for (const fragment of [...targeted, ...broadcasts]) {
    const existing = shadowed.get(fragment.id);
    if (!existing || fragment.scope === 'coordinator') {
      shadowed.set(fragment.id, fragment);
    }
  }
  return Array.from(shadowed.values());
}

/**
 * Deterministic content hash over the merged agent-visible set (all
 * targets' live rows). Used by the coordinator mirror sync to detect changes.
 */
export function mergedContentHash(): string {
  const merged = listFragments().filter(
    f => f.expiresAt === null || f.expiresAt > Date.now()
  );
  const sorted = [...merged].sort((a, b) =>
    `${a.id}\u0000${a.target}`.localeCompare(`${b.id}\u0000${b.target}`)
  );
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
