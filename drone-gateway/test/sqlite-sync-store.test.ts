import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initGatewaySchema } from '../src/store/db.js';
import { SqliteSyncStore } from '../src/store/sqlite-sync-store.js';
import type { ISyncResponse } from 'matrix-js-sdk/lib/sync-accumulator.js';
import type { IStateEventWithRoomId } from 'matrix-js-sdk/lib/@types/search.js';
import type { IStartClientOpts } from 'matrix-js-sdk/lib/client.js';
import type { ToDeviceBatchWithTxnId } from 'matrix-js-sdk/lib/models/ToDeviceMessage.js';

describe('SqliteSyncStore', () => {
  let db: Database.Database;
  let store: SqliteSyncStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initGatewaySchema(db);
    store = new SqliteSyncStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('lifecycle', () => {
    it('isNewlyCreated returns true for empty store', async () => {
      expect(await store.isNewlyCreated()).toBe(true);
    });

    it('startup resolves without error', async () => {
      await expect(store.startup()).resolves.toBeUndefined();
    });

    it('destroy resolves without error', async () => {
      await expect(store.destroy()).resolves.toBeUndefined();
    });
  });

  describe('saved sync', () => {
    it('getSavedSync returns null when empty', async () => {
      const result = await store.getSavedSync();
      expect(result).toBeNull();
    });

    it('getSavedSyncToken returns null when empty', async () => {
      const result = await store.getSavedSyncToken();
      expect(result).toBeNull();
    });

    it('round-trips saved sync data', async () => {
      const syncData: ISyncResponse = {
        next_batch: 's1234',
        rooms: { join: {}, invite: {}, leave: {} },
        account_data: { events: [] },
        to_device: { events: [] },
        device_lists: { changed: [], left: [] },
        device_one_time_keys_count: {},
        device_unused_fallback_key_types: [],
        groups: { join: {}, invite: {}, leave: {} },
      };

      await store.setSyncData(syncData);
      const saved = await store.getSavedSync();
      expect(saved).not.toBeNull();
      expect(saved!.nextBatch).toBe('s1234');

      const token = await store.getSavedSyncToken();
      expect(token).toBe('s1234');
    });

    it('overwrites existing saved sync', async () => {
      await store.setSyncData({ next_batch: 's1' } as any);
      await store.setSyncData({ next_batch: 's2' } as any);
      const token = await store.getSavedSyncToken();
      expect(token).toBe('s2');
    });
  });

  describe('OOB members', () => {
    it('getOutOfBandMembers returns null when empty', async () => {
      const result = await store.getOutOfBandMembers('!room:test');
      expect(result).toBeNull();
    });

    it('round-trips OOB members', async () => {
      const members: IStateEventWithRoomId[] = [
        {
          room_id: '!room:test',
          type: 'm.room.member',
          state_key: '@alice:test',
          content: { membership: 'join' },
          event_id: '$1',
        } as any,
      ];

      await store.setOutOfBandMembers('!room:test', members);
      const result = await store.getOutOfBandMembers('!room:test');
      expect(result).not.toBeNull();
      expect(result!.length).toBe(1);
      expect(result![0].state_key).toBe('@alice:test');
    });

    it('clearOutOfBandMembers removes data', async () => {
      await store.setOutOfBandMembers('!room:test', []);
      await store.clearOutOfBandMembers('!room:test');
      const result = await store.getOutOfBandMembers('!room:test');
      expect(result).toBeNull();
    });
  });

  describe('client options', () => {
    it('getClientOptions returns undefined when empty', async () => {
      const result = await store.getClientOptions();
      expect(result).toBeUndefined();
    });

    it('round-trips client options', async () => {
      const opts: IStartClientOpts = { initialSyncLimit: 10 };
      await store.storeClientOptions(opts);
      const result = await store.getClientOptions();
      expect(result).toEqual(opts);
    });
  });

  describe('pending events', () => {
    it('getPendingEvents returns empty array when none', async () => {
      const result = await store.getPendingEvents('!room:test');
      expect(result).toEqual([]);
    });

    it('round-trips pending events', async () => {
      const events = [{ type: 'm.room.message', content: { body: 'hello' } }];
      await store.setPendingEvents('!room:test', events);
      const result = await store.getPendingEvents('!room:test');
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('m.room.message');
    });

    it('clears pending events when empty array', async () => {
      await store.setPendingEvents('!room:test', [
        { type: 'm.room.message' } as any,
      ]);
      await store.setPendingEvents('!room:test', []);
      const result = await store.getPendingEvents('!room:test');
      expect(result).toEqual([]);
    });
  });

  describe('to-device batches', () => {
    it('getOldestToDeviceBatch returns null when empty', async () => {
      const result = await store.getOldestToDeviceBatch();
      expect(result).toBeNull();
    });

    it('round-trips to-device batches', async () => {
      const batches: ToDeviceBatchWithTxnId[] = [
        {
          eventType: 'm.room_key_request',
          txnId: 'txn1',
          batch: {
            '@alice:test': {
              DEVICE1: { type: 'm.room_key_request', content: {} },
            },
          },
        },
      ];

      await store.saveToDeviceBatches(batches);
      const oldest = await store.getOldestToDeviceBatch();
      expect(oldest).not.toBeNull();
      expect(oldest!.eventType).toBe('m.room_key_request');
      expect(oldest!.txnId).toBe('txn1');

      await store.removeToDeviceBatch(oldest!.id);
      const empty = await store.getOldestToDeviceBatch();
      expect(empty).toBeNull();
    });
  });

  describe('deleteAllData', () => {
    it('clears all persisted data', async () => {
      await store.setSyncData({ next_batch: 's1' } as any);
      await store.setOutOfBandMembers('!room:test', []);
      await store.storeClientOptions({ initialSyncLimit: 10 });

      await store.deleteAllData();

      expect(await store.getSavedSync()).toBeNull();
      expect(await store.getOutOfBandMembers('!room:test')).toBeNull();
      expect(await store.getClientOptions()).toBeUndefined();
    });
  });

  describe('save / wantsSave', () => {
    it('wantsSave returns false initially', () => {
      expect(store.wantsSave()).toBe(false);
    });

    it('save resolves without error', async () => {
      await expect(store.save()).resolves.toBeUndefined();
    });
  });
});
