import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initGatewaySchema } from '../src/store/db.js';
import { SqliteCryptoStore } from '../src/store/sqlite-crypto-store.js';
import { MigrationState } from 'matrix-js-sdk/lib/crypto/store/base.js';
import type { OutgoingRoomKeyRequest } from 'matrix-js-sdk/lib/crypto/store/base.js';
import type { InboundGroupSessionData } from 'matrix-js-sdk/lib/crypto/OlmDevice.js';
import type { ISessionInfo } from 'matrix-js-sdk/lib/crypto/store/base.js';
import type { IRoomEncryption } from 'matrix-js-sdk/lib/crypto/RoomList.js';
import type { IDeviceData } from 'matrix-js-sdk/lib/crypto/store/base.js';
import type { ParkedSharedHistory } from 'matrix-js-sdk/lib/crypto/store/base.js';

describe('SqliteCryptoStore', () => {
  let db: Database.Database;
  let store: SqliteCryptoStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initGatewaySchema(db);
    store = new SqliteCryptoStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('lifecycle', () => {
    it('containsData returns false for empty store', async () => {
      expect(await store.containsData()).toBe(false);
    });

    it('startup returns self', async () => {
      const result = await store.startup();
      expect(result).toBe(store);
    });

    it('deleteAllData clears everything', async () => {
      // Store something
      store.storeAccount(null, 'test-pickle');
      expect(await store.containsData()).toBe(true);

      await store.deleteAllData();
      expect(await store.containsData()).toBe(false);
    });
  });

  describe('migration state', () => {
    it('defaults to NOT_STARTED', async () => {
      expect(await store.getMigrationState()).toBe(MigrationState.NOT_STARTED);
    });

    it('round-trips migration state', async () => {
      await store.setMigrationState(MigrationState.OLM_SESSIONS_MIGRATED);
      expect(await store.getMigrationState()).toBe(
        MigrationState.OLM_SESSIONS_MIGRATED
      );
    });
  });

  describe('account', () => {
    it('getAccount returns null when empty', () => {
      store.getAccount(null, pickle => {
        expect(pickle).toBeNull();
      });
    });

    it('round-trips account pickle', () => {
      store.storeAccount(null, 'my-pickle');
      store.getAccount(null, pickle => {
        expect(pickle).toBe('my-pickle');
      });
    });

    it('overwrites existing account', () => {
      store.storeAccount(null, 'first');
      store.storeAccount(null, 'second');
      store.getAccount(null, pickle => {
        expect(pickle).toBe('second');
      });
    });
  });

  describe('cross-signing keys', () => {
    it('getCrossSigningKeys returns null when empty', () => {
      store.getCrossSigningKeys(null, keys => {
        expect(keys).toBeNull();
      });
    });

    it('round-trips cross-signing keys', () => {
      const keys = { master: { keys: { 'ed25519:abc': 'key1' } } };
      store.storeCrossSigningKeys(null, keys);
      store.getCrossSigningKeys(null, result => {
        expect(result).toEqual(keys);
      });
    });
  });

  describe('outgoing room key requests', () => {
    const makeRequest = (id: string): OutgoingRoomKeyRequest => ({
      requestId: id,
      recipients: [{ userId: '@alice:test', deviceId: 'DEVICE1' }],
      requestBody: {
        algorithm: 'm.megolm.v1',
        room_id: '!room:test',
        sender_key: 'abc',
        session_id: 'sess1',
      },
      state: 0,
    });

    it('getOrAddOutgoingRoomKeyRequest creates and returns', async () => {
      const req = makeRequest('req1');
      const result = await store.getOrAddOutgoingRoomKeyRequest(req);
      expect(result.requestId).toBe('req1');
    });

    it('getOrAddOutgoingRoomKeyRequest returns existing', async () => {
      const req = makeRequest('req1');
      await store.getOrAddOutgoingRoomKeyRequest(req);
      const result = await store.getOrAddOutgoingRoomKeyRequest(req);
      expect(result.requestId).toBe('req1');
    });

    it('getOutgoingRoomKeyRequestByState finds matching', async () => {
      const req = makeRequest('req1');
      await store.getOrAddOutgoingRoomKeyRequest(req);
      const result = await store.getOutgoingRoomKeyRequestByState([0]);
      expect(result).not.toBeNull();
      expect(result!.requestId).toBe('req1');
    });

    it('updateOutgoingRoomKeyRequest updates state', async () => {
      const req = makeRequest('req1');
      await store.getOrAddOutgoingRoomKeyRequest(req);
      const updated = await store.updateOutgoingRoomKeyRequest('req1', 0, {
        state: 1,
      });
      expect(updated).not.toBeNull();
      expect(updated!.state).toBe(1);
    });

    it('deleteOutgoingRoomKeyRequest removes and returns', async () => {
      const req = makeRequest('req1');
      await store.getOrAddOutgoingRoomKeyRequest(req);
      const deleted = await store.deleteOutgoingRoomKeyRequest('req1', 0);
      expect(deleted).not.toBeNull();
      expect(deleted!.requestId).toBe('req1');
      const found = await store.getOutgoingRoomKeyRequestByState([0]);
      expect(found).toBeNull();
    });
  });

  describe('Olm sessions', () => {
    it('countEndToEndSessions returns 0 when empty', () => {
      store.countEndToEndSessions(null, count => {
        expect(count).toBe(0);
      });
    });

    it('round-trips an Olm session', () => {
      const info: ISessionInfo = {
        deviceKey: 'device1',
        sessionId: 'sess1',
        session: 'olm-pickle',
        lastReceivedMessageTs: 1000,
      };
      store.storeEndToEndSession('device1', 'sess1', info, null);
      store.getEndToEndSession('device1', 'sess1', null, result => {
        expect(result).not.toBeNull();
        expect(result!.deviceKey).toBe('device1');
        expect(result!.sessionId).toBe('sess1');
        expect(result!.session).toBe('olm-pickle');
        expect(result!.lastReceivedMessageTs).toBe(1000);
      });
    });

    it('getEndToEndSessions returns all sessions for a device', () => {
      store.storeEndToEndSession(
        'device1',
        'sess1',
        { deviceKey: 'device1', sessionId: 'sess1', session: 'a' },
        null
      );
      store.storeEndToEndSession(
        'device1',
        'sess2',
        { deviceKey: 'device1', sessionId: 'sess2', session: 'b' },
        null
      );
      store.getEndToEndSessions('device1', null, sessions => {
        expect(Object.keys(sessions)).toHaveLength(2);
        expect(sessions['sess1'].session).toBe('a');
        expect(sessions['sess2'].session).toBe('b');
      });
    });

    it('getEndToEndSessionsBatch returns sessions in batches', async () => {
      for (let i = 0; i < 3; i++) {
        store.storeEndToEndSession(
          `dev${i}`,
          `sess${i}`,
          { deviceKey: `dev${i}`, sessionId: `sess${i}`, session: `p${i}` },
          null
        );
      }
      const batch = await store.getEndToEndSessionsBatch();
      expect(batch).not.toBeNull();
      expect(batch!.length).toBe(3);
    });

    it('deleteEndToEndSessionsBatch removes sessions', async () => {
      store.storeEndToEndSession(
        'dev1',
        'sess1',
        { deviceKey: 'dev1', sessionId: 'sess1', session: 'p' },
        null
      );
      await store.deleteEndToEndSessionsBatch([
        { deviceKey: 'dev1', sessionId: 'sess1' },
      ]);
      store.getEndToEndSession('dev1', 'sess1', null, result => {
        expect(result).toBeNull();
      });
    });
  });

  describe('inbound group sessions', () => {
    const makeData = (): InboundGroupSessionData => ({
      session_id: 'sess1',
      session_key: 'key1',
      sender_key: 'sender1',
      forwarding_curve25519_key_chain: [],
      keys_claimed: {},
    });

    it('round-trips an inbound group session', () => {
      const data = makeData();
      store.addEndToEndInboundGroupSession('sender1', 'sess1', data, null);
      store.getEndToEndInboundGroupSession(
        'sender1',
        'sess1',
        null,
        (session, withheld) => {
          expect(session).not.toBeNull();
          expect(session!.session_id).toBe('sess1');
          expect(withheld).toBeNull();
        }
      );
    });

    it('countEndToEndInboundGroupSessions returns count', async () => {
      const data = makeData();
      store.addEndToEndInboundGroupSession('sender1', 'sess1', data, null);
      const count = await store.countEndToEndInboundGroupSessions();
      expect(count).toBe(1);
    });

    it('getEndToEndInboundGroupSessionsBatch returns batches', async () => {
      const data = makeData();
      store.addEndToEndInboundGroupSession('sender1', 'sess1', data, null);
      const batch = await store.getEndToEndInboundGroupSessionsBatch();
      expect(batch).not.toBeNull();
      expect(batch!.length).toBe(1);
    });
  });

  describe('E2EE rooms', () => {
    it('round-trips room encryption info', () => {
      const info: IRoomEncryption = {
        algorithm: 'm.megolm.v1',
        rotation_period_ms: 1000,
        rotation_period_msgs: 100,
      };
      store.storeEndToEndRoom('!room:test', info, null);
      store.getEndToEndRooms(null, rooms => {
        expect(rooms['!room:test']).toEqual(info);
      });
    });
  });

  describe('device data', () => {
    it('getEndToEndDeviceData returns null when empty', () => {
      store.getEndToEndDeviceData(null, data => {
        expect(data).toBeNull();
      });
    });

    it('round-trips device data', () => {
      const data: IDeviceData = {
        devices: {
          '@alice:test': {
            DEVICE1: { keys: {}, algorithms: [], verified: 0, known: true },
          },
        },
        trackingStatus: {},
      };
      store.storeEndToEndDeviceData(data, null);
      store.getEndToEndDeviceData(null, result => {
        expect(result).not.toBeNull();
        expect(result!.devices['@alice:test']['DEVICE1'].verified).toBe(0);
      });
    });
  });

  describe('shared history', () => {
    it('addSharedHistoryInboundGroupSession stores and retrieves', async () => {
      store.addSharedHistoryInboundGroupSession(
        '!room:test',
        'sender1',
        'sess1'
      );
      const result =
        await store.getSharedHistoryInboundGroupSessions('!room:test');
      expect(result).toHaveLength(1);
      expect(result[0][0]).toBe('sender1');
      expect(result[0][1]).toBe('sess1');
    });

    it('addParkedSharedHistory and takeParkedSharedHistory', async () => {
      const data: ParkedSharedHistory = {
        senderId: '@alice:test',
        senderKey: 'sender1',
        sessionId: 'sess1',
        sessionKey: 'key1',
        keysClaimed: {},
        forwardingCurve25519KeyChain: [],
      };
      store.addParkedSharedHistory('!room:test', data);
      const result = await store.takeParkedSharedHistory('!room:test');
      expect(result).toHaveLength(1);
      expect(result[0].senderId).toBe('@alice:test');
      // Second take should be empty
      const empty = await store.takeParkedSharedHistory('!room:test');
      expect(empty).toHaveLength(0);
    });
  });

  describe('doTxn', () => {
    it('executes the function with null txn', async () => {
      const result = await store.doTxn('readonly', ['crypto_account'], txn => {
        expect(txn).toBeNull();
        return 42;
      });
      expect(result).toBe(42);
    });
  });
});
