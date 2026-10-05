import { MemoryStore } from 'matrix-js-sdk/lib/store/memory.js';
import { MatrixEvent } from 'matrix-js-sdk/lib/models/event.js';
import type { GatewayDatabase } from './db.js';
import type { IStore, ISavedSync } from 'matrix-js-sdk/lib/store/index.js';
import type { IEvent } from 'matrix-js-sdk/lib/models/event.js';
import {
  SyncAccumulator,
  type ISyncData,
  type ISyncResponse,
} from 'matrix-js-sdk/lib/sync-accumulator.js';
import { deepCopy } from 'matrix-js-sdk/lib/utils.js';
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
 * the data that the SDK needs to survive a restart: the accumulated sync
 * state, presence events, out-of-band membership, pending events, to-device
 * batches, and client options.
 *
 * Sync responses are deltas: the first carries the room state, later ones
 * carry only a new token and whatever changed. Persisting the last response
 * would therefore discard all room data. Like the SDK's IndexedDB backend,
 * this store folds every response into a {@link SyncAccumulator} and persists
 * the *accumulated* state, so a restarted client still knows its rooms.
 *
 * On startup the client replays the accumulated state to rebuild live
 * Room/User objects in memory — we never serialize Room/User objects directly
 * (the SDK has no Room.fromJSON).
 */
export class SqliteSyncStore extends MemoryStore implements IStore {
  private db: GatewayDatabase;
  private syncTs: number;
  private userModifiedMap: Record<string, number> = {};
  private syncAccumulator = new SyncAccumulator();
  private accumulatorHydrated = false;
  private accumulatorHydration: Promise<void> | null = null;

  constructor(db: GatewayDatabase) {
    super({});
    this.db = db;
    this.syncTs = Date.now();
  }

  // ── Startup / lifecycle ─────────────────────────────────────

  async startup(): Promise<void> {
    // Rehydrate the accumulated sync state, then load presence events from
    // SQLite and replay them into MemoryStore.
    await this.ensureAccumulator();

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

  /**
   * Rehydrate the accumulator from persisted state exactly once. Concurrent
   * callers share one in-flight hydration.
   */
  private ensureAccumulator(): Promise<void> {
    if (this.accumulatorHydrated) return Promise.resolve();
    this.accumulatorHydration ??= this.hydrateAccumulator().then(() => {
      this.accumulatorHydrated = true;
    });
    return this.accumulatorHydration;
  }

  private async hydrateAccumulator(): Promise<void> {
    const row = this.db
      .prepare(`SELECT data FROM saved_sync WHERE id = 1`)
      .get() as { data: string } | undefined;
    if (!row) return;

    const persisted = parsePersistedSync(row.data);
    if (!persisted) return;

    // Replay the accumulated state through the accumulator in database mode,
    // mirroring the SDK's IndexedDB backend init().
    this.syncAccumulator.accumulate(
      {
        next_batch: persisted.nextBatch,
        rooms: persisted.roomsData,
        account_data: { events: persisted.accountData },
      },
      true
    );
  }

  async setSyncData(syncData: ISyncResponse): Promise<void> {
    await this.ensureAccumulator();
    this.syncAccumulator.accumulate(syncData);
    const accumulated = this.syncAccumulator.getJSON(true);
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO saved_sync (id, sync_token, data)
      VALUES (1, ?, ?)
    `
      )
      .run(accumulated.nextBatch ?? '', JSON.stringify(accumulated));
  }

  async getSavedSync(): Promise<ISavedSync | null> {
    await this.ensureAccumulator();
    const data = this.syncAccumulator.getJSON();
    if (!data.nextBatch) return null;
    return deepCopy(data);
  }

  async getSavedSyncToken(): Promise<string | null> {
    await this.ensureAccumulator();
    return this.syncAccumulator.getNextBatchToken() ?? null;
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
    this.syncAccumulator = new SyncAccumulator();
    this.accumulatorHydrated = true;
    this.accumulatorHydration = null;
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

/**
 * Parse the persisted `saved_sync.data` blob into accumulated sync state.
 *
 * New rows hold a serialized {@link ISyncData} (`nextBatch`/`roomsData`/
 * `accountData`). Rows written by the old clobbering store hold a raw
 * `/sync` response instead; those are read best-effort so a single full
 * sync heals legacy databases. Returns null when the blob is unusable.
 */
function parsePersistedSync(data: string): ISyncData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;

  if (typeof record.nextBatch === 'string') {
    return {
      nextBatch: record.nextBatch,
      roomsData: (record.roomsData ?? emptyRooms()) as ISyncData['roomsData'],
      accountData: (record.accountData ?? []) as ISyncData['accountData'],
    };
  }

  if (typeof record.next_batch === 'string') {
    return {
      nextBatch: record.next_batch,
      roomsData: (record.rooms ?? emptyRooms()) as ISyncData['roomsData'],
      accountData: ((record.account_data as { events?: unknown[] } | undefined)
        ?.events ?? []) as ISyncData['accountData'],
    };
  }

  return null;
}

function emptyRooms(): ISyncData['roomsData'] {
  return { join: {}, invite: {}, leave: {}, knock: {} };
}
