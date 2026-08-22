import { randomUUID } from 'node:crypto';
import { getDatabase } from './index.js';

export interface OutboxEntry {
  id: string;
  kind: string;
  endpoint: string;
  method: string;
  body: string | null;
  createdAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
  deliveredAt: number | null;
}

type OutboxRow = OutboxEntry;

/**
 * Base delay for outbox retry backoff, in milliseconds. Exposed for tests so
 * retry timing can be exercised without waiting real seconds.
 */
export const OUTBOX_RETRY_BASE_MS = 1000;

/**
 * Enqueue a fire-and-forget write for later delivery to the coordinator.
 * First attempts are due immediately; retries back off exponentially.
 */
export function enqueueOutbox(entry: {
  kind: string;
  endpoint: string;
  method: string;
  body?: unknown;
}): OutboxEntry {
  const id = randomUUID();
  const stmt = getDatabase().prepare(
    `INSERT INTO outbox (id, kind, endpoint, method, body, createdAt, attempts, lastAttemptAt, lastError, deliveredAt)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL)`
  );
  stmt.run(
    id,
    entry.kind,
    entry.endpoint,
    entry.method,
    entry.body === undefined ? null : JSON.stringify(entry.body),
    Date.now()
  );
  const row = getDatabase()
    .prepare('SELECT * FROM outbox WHERE id = ?')
    .get(id) as OutboxRow | undefined;
  if (!row) {
    throw new Error(`Outbox insert failed: ${entry.kind} ${entry.endpoint}`);
  }
  return row;
}

/**
 * Fetch the next batch of undelivered entries due for a delivery attempt.
 * First attempts (attempts = 0) are always due; retries wait
 * OUTBOX_RETRY_BASE_MS * 2^(attempts-1) after the previous attempt.
 */
export function dequeueDueOutbox(
  limit: number,
  now = Date.now()
): OutboxEntry[] {
  const rows = getDatabase()
    .prepare(
      'SELECT * FROM outbox WHERE deliveredAt IS NULL ORDER BY createdAt ASC'
    )
    .all() as OutboxRow[];
  const due = rows.filter(row => {
    if (row.attempts === 0) {
      return true;
    }
    const backoff = OUTBOX_RETRY_BASE_MS * 2 ** (row.attempts - 1);
    const last = row.lastAttemptAt ?? row.createdAt;
    return now - last >= backoff;
  });
  return due.slice(0, limit);
}

/** Count undelivered entries, optionally including not-yet-due retries. */
export function countPendingOutbox(includeNotYetDue = false): number {
  if (includeNotYetDue) {
    const row = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM outbox WHERE deliveredAt IS NULL')
      .get() as { n: number };
    return row.n;
  }
  return dequeueDueOutbox(Number.MAX_SAFE_INTEGER).length;
}

export function markOutboxDelivered(id: string): void {
  getDatabase()
    .prepare('UPDATE outbox SET deliveredAt = ?, lastError = NULL WHERE id = ?')
    .run(Date.now(), id);
}

export function markOutboxFailed(id: string, error: string): void {
  getDatabase()
    .prepare(
      `UPDATE outbox
       SET attempts = attempts + 1, lastAttemptAt = ?, lastError = ?
       WHERE id = ?`
    )
    .run(Date.now(), error.slice(0, 2000), id);
}

export function deleteOutboxEntry(id: string): void {
  getDatabase().prepare('DELETE FROM outbox WHERE id = ?').run(id);
}
