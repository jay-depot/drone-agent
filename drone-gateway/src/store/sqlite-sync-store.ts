import { MemoryStore } from 'matrix-js-sdk/lib/store/memory.js';
import { MatrixEvent } from 'matrix-js-sdk/lib/models/event.js';
import type { GatewayDatabase } from './db.js';
import type { IStore, ISavedSync } from 'matrix-js-sdk/lib/store/index.js';
import type { IEvent } from 'matrix-js-sdk/lib/models/event.js';
import type { ISyncResponse } from 'matrix-js-sdk/lib/sync-accumulator.js';
import type { IStartClientOpts } from 'matrix-js-sdk/lib/client.js';
import type { IStateEventWithRoomId } from 'matrix-js-sdk/lib/@types/search.js';
import type {
  IndexedToDeviceBatch,
  ToDeviceBatchWithTxnId,
} from 'matrix-js-sdk/lib/models/ToDeviceMessage.js';

const WRITE_DELAY_MS = 1000 * 30; // 30 seconds, matching IndexedDBStore

/**
 * SQLite-backed Matrix sync store.
 *
 * Extends MemoryStore (same as matrix-js-sdk's IndexedDBStore) and persists
 * the data that the SDK needs to survive a restart: the saved-sync blob,
 * presence events, out-of-band membership, pending events, to-device
 * batches, and client options.
 *
 * On startup the client replays the saved sync to rebuild live Room/User
 * objects in memory — we never serialize Room/User objects directly (the
 * SDK has no Room.fromJSON).
 */
export class SqliteSyncStore extends MemoryStore implements IStore {
  private db: GatewayDatabase;
  private syncTs: number;
  private userModifiedMap: Record<string, number> = {};

  constructor(db: GatewayDatabase) {
    super({});
    this.db = db;
    this.syncTs = Date.now();
  }

  // ── Startup / lifecycle ─────────────────────────────────────

  async startup(): Promise<void> {
    // Load presence events from SQLite and replay them into MemoryStore
    const rows = this.db
      .prepare(`SELECT user_id, event FROM presence_events`)
      .all() as { user_id: string; event: string }[];

    for (const r of rows) {
      if (!this.createUser) {
        throw new Error(
          'SqliteSyncStore.startup must be called after assigning it to the client, not before!'
        );
      }
      const u = this.createUser(r.user_id);
      const rawEvent = JSON.parse(r.event);
      u.setPresenceEvent(new MatrixEvent(rawEvent));
      this.userModifiedMap[u.userId] = u.getLastModifiedTime();
      this.storeUser(u);
    }
  }

  async destroy(): Promise<void> {
    // Nothing to clean up — the db is closed by the adapter
  }

  // ── Saved sync ─────────────────────────────────────────────

  async setSyncData(syncData: ISyncResponse): Promise<void> {
    // The sync token is in syncData.next_batch
    const nextBatch = syncData.next_batch ?? '';
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO saved_sync (id, sync_token, data)
      VALUES (1, ?, ?)
    `
      )
      .run(nextBatch, JSON.stringify(syncData));
  }

  async getSavedSync(): Promise<ISavedSync | null> {
    const row = this.db
      .prepare(`SELECT sync_token, data FROM saved_sync WHERE id = 1`)
      .get() as { sync_token: string; data: string } | undefined;
    if (!row) return null;
    const raw = JSON.parse(row.data) as ISyncResponse;
    // Transform snake_case next_batch to camelCase nextBatch for ISavedSync
    return {
      nextBatch: raw.next_batch ?? row.sync_token,
      roomsData: raw.rooms ?? { join: {}, invite: {}, leave: {} },
      accountData: raw.account_data?.events ?? [],
    };
  }

  async getSavedSyncToken(): Promise<string | null> {
    const row = this.db
      .prepare(`SELECT sync_token FROM saved_sync WHERE id = 1`)
      .get() as { sync_token: string } | undefined;
    return row?.sync_token ?? null;
  }

  // ── Presence events ────────────────────────────────────────

  private async reallySave(): Promise<void> {
    this.syncTs = Date.now();

    // Persist changed users (presence events)
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO presence_events (user_id, event)
      VALUES (?, ?)
    `);

    for (const u of this.getUsers()) {
      if (this.userModifiedMap[u.userId] === u.getLastModifiedTime()) continue;
      if (!u.events.presence) continue;
      stmt.run(u.userId, JSON.stringify(u.events.presence.event));
      this.userModifiedMap[u.userId] = u.getLastModifiedTime();
    }
  }

  // ── Save / wantsSave ───────────────────────────────────────

  wantsSave(): boolean {
    return Date.now() - this.syncTs > WRITE_DELAY_MS;
  }

  async save(force?: boolean): Promise<void> {
    if (force || this.wantsSave()) {
      await this.reallySave();
    }
  }

  // ── OOB members ─────────────────────────────────────────────

  async getOutOfBandMembers(
    roomId: string
  ): Promise<IStateEventWithRoomId[] | null> {
    const row = this.db
      .prepare(`SELECT events FROM oob_members WHERE room_id = ?`)
      .get(roomId) as { events: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.events) as IStateEventWithRoomId[];
  }

  async setOutOfBandMembers(
    roomId: string,
    membershipEvents: IStateEventWithRoomId[]
  ): Promise<void> {
    super.setOutOfBandMembers(roomId, membershipEvents);
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO oob_members (room_id, events) VALUES (?, ?)
    `
      )
      .run(roomId, JSON.stringify(membershipEvents));
  }

  async clearOutOfBandMembers(roomId: string): Promise<void> {
    super.clearOutOfBandMembers(roomId);
    this.db.prepare(`DELETE FROM oob_members WHERE room_id = ?`).run(roomId);
  }

  // ── Client options ──────────────────────────────────────────

  async getClientOptions(): Promise<IStartClientOpts | undefined> {
    const row = this.db
      .prepare(`SELECT options FROM client_options WHERE id = 1`)
      .get() as { options: string } | undefined;
    return row ? JSON.parse(row.options) : undefined;
  }

  async storeClientOptions(options: IStartClientOpts): Promise<void> {
    super.storeClientOptions(options);
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO client_options (id, options) VALUES (1, ?)
    `
      )
      .run(JSON.stringify(options));
  }

  // ── Pending events ─────────────────────────────────────────

  async getPendingEvents(roomId: string): Promise<Partial<IEvent>[]> {
    const row = this.db
      .prepare(`SELECT events FROM pending_events WHERE room_id = ?`)
      .get(roomId) as { events: string } | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.events) as Partial<IEvent>[];
    } catch {
      return [];
    }
  }

  async setPendingEvents(
    roomId: string,
    events: Partial<IEvent>[]
  ): Promise<void> {
    if (events.length > 0) {
      this.db
        .prepare(
          `
        INSERT OR REPLACE INTO pending_events (room_id, events) VALUES (?, ?)
      `
        )
        .run(roomId, JSON.stringify(events));
    } else {
      this.db
        .prepare(`DELETE FROM pending_events WHERE room_id = ?`)
        .run(roomId);
    }
  }

  // ── To-device batches ──────────────────────────────────────

  async saveToDeviceBatches(batches: ToDeviceBatchWithTxnId[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO to_device_batches (event_type, txn_id, batch)
      VALUES (?, ?, ?)
    `);
    for (const b of batches) {
      stmt.run(b.eventType, b.txnId, JSON.stringify(b.batch));
    }
  }

  async getOldestToDeviceBatch(): Promise<IndexedToDeviceBatch | null> {
    const row = this.db
      .prepare(`SELECT * FROM to_device_batches ORDER BY id ASC LIMIT 1`)
      .get() as
      | { id: number; event_type: string; txn_id: string; batch: string }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      eventType: row.event_type,
      txnId: row.txn_id,
      batch: JSON.parse(row.batch),
    };
  }

  async removeToDeviceBatch(id: number): Promise<void> {
    this.db.prepare(`DELETE FROM to_device_batches WHERE id = ?`).run(id);
  }

  // ── Delete all data ────────────────────────────────────────

  async deleteAllData(): Promise<void> {
    super.deleteAllData();
    this.db.exec(`
      DELETE FROM saved_sync;
      DELETE FROM presence_events;
      DELETE FROM oob_members;
      DELETE FROM pending_events;
      DELETE FROM to_device_batches;
      DELETE FROM client_options;
    `);
  }

  // ── isNewlyCreated ─────────────────────────────────────────

  isNewlyCreated(): Promise<boolean> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM saved_sync`)
      .get() as { cnt: number };
    return Promise.resolve(row.cnt === 0);
  }
}
