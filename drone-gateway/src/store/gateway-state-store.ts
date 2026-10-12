import type { DronePortableContextExport } from 'drone-core';
import type { GatewayDatabase } from './db.js';

/**
 * One row per conversation holding the latest exported portable context.
 * `better-sqlite3` is synchronous by design, so these methods are sync — this
 * mirrors the beacon/coordinator DB layers.
 */
export interface ContextSnapshotStore {
  saveSnapshot(
    conversationId: string,
    context: DronePortableContextExport
  ): void;
  getSnapshot(conversationId: string): DronePortableContextExport | null;
  deleteSnapshot(conversationId: string): void;
}

export interface OutboundLedgerEntry {
  id: number;
  platformRef?: string;
  text: string;
  createdAt: number;
}

export interface OutboundLedgerHandle {
  append(
    conversationId: string,
    entry: { platformRef?: string; text: string }
  ): void;
  list(conversationId: string): OutboundLedgerEntry[];
  remove(ids: number[]): void;
}

/**
 * Portable-context snapshot store. The stored `context` is always the value
 * returned by the capability's `exportContext`, which has already stripped the
 * continuation-disclosure reminder (see D5) — the gateway never rewrites it.
 */
export function createContextSnapshotStore(
  db: GatewayDatabase
): ContextSnapshotStore {
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO context_snapshots (conversation_id, context, updated_at)
     VALUES (?, ?, ?)`
  );
  const select = db.prepare(
    `SELECT context FROM context_snapshots WHERE conversation_id = ?`
  );
  const del = db.prepare(
    `DELETE FROM context_snapshots WHERE conversation_id = ?`
  );

  return {
    saveSnapshot(conversationId, context) {
      upsert.run(conversationId, JSON.stringify(context), Date.now());
    },
    getSnapshot(conversationId) {
      const row = select.get(conversationId) as { context: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.context) as DronePortableContextExport;
    },
    deleteSnapshot(conversationId) {
      del.run(conversationId);
    },
  };
}

/**
 * Outbound ledger: messages the gateway posted on the agent's behalf (via the
 * injection API), persisted so they survive a restart. Rows are deleted only
 * after a turn drains them successfully.
 */
export function createOutboundLedger(
  db: GatewayDatabase
): OutboundLedgerHandle {
  const insert = db.prepare(
    `INSERT INTO pending_outbound (conversation_id, platform_ref, text, created_at)
     VALUES (?, ?, ?, ?)`
  );
  const select = db.prepare(
    `SELECT id, platform_ref, text, created_at
     FROM pending_outbound
     WHERE conversation_id = ?
     ORDER BY id`
  );

  return {
    append(conversationId, entry) {
      insert.run(
        conversationId,
        entry.platformRef ?? null,
        entry.text,
        Date.now()
      );
    },
    list(conversationId) {
      const rows = select.all(conversationId) as Array<{
        id: number;
        platform_ref: string | null;
        text: string;
        created_at: number;
      }>;
      return rows.map(row => ({
        id: row.id,
        platformRef: row.platform_ref ?? undefined,
        text: row.text,
        createdAt: row.created_at,
      }));
    },
    remove(ids) {
      if (ids.length === 0) return;
      const placeholders = ids.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM pending_outbound WHERE id IN (${placeholders})`
      ).run(...ids);
    },
  };
}
