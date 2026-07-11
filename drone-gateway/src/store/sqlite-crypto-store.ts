import type { GatewayDatabase } from './db.js';
import type {
  CryptoStore,
  IDeviceData,
  ISession,
  SessionExtended,
  ISessionInfo,
  IWithheld,
  OutgoingRoomKeyRequest,
  SecretStorePrivateKeys,
  InboundGroupSessionData,
  IRoomEncryption,
  IRoomKeyRequestBody,
  IRoomKeyRequestRecipient,
} from 'matrix-js-sdk/lib/crypto/store/base.js';
import { MigrationState } from 'matrix-js-sdk/lib/crypto/store/base.js';
import type { CrossSigningKeyInfo } from 'matrix-js-sdk/lib/crypto-api/index.js';
import type { Mode } from 'matrix-js-sdk/lib/crypto/store/base.js';
import type { Logger } from 'matrix-js-sdk/lib/logger.js';

const SESSION_BATCH_SIZE = 50;

/**
 * SQLite-backed implementation of matrix-js-sdk's CryptoStore.
 *
 * Each method maps to a prepared statement on the shared gateway database.
 * Callback-style methods ignore the `_txn` parameter (SQLite transactions
 * are handled by better-sqlite3's auto-commit) and invoke the callback
 * with the value synchronously.
 *
 * This is the only way to get persistent E2EE keys on a headless Node host
 * (the SDK ships only Memory/LocalStorage/IndexedDB stores, none of which
 * work on a Pi without a browser runtime).
 */
export class SqliteCryptoStore implements CryptoStore {
  private db: GatewayDatabase;

  constructor(db: GatewayDatabase) {
    this.db = db;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  containsData(): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT (
        SELECT COUNT(*) FROM crypto_meta
      ) + (
        SELECT COUNT(*) FROM crypto_account
      ) + (
        SELECT COUNT(*) FROM cross_signing_keys
      ) + (
        SELECT COUNT(*) FROM secret_store_private_keys
      ) + (
        SELECT COUNT(*) FROM outgoing_room_key_requests
      ) + (
        SELECT COUNT(*) FROM end_to_end_sessions
      ) + (
        SELECT COUNT(*) FROM inbound_group_sessions
      ) + (
        SELECT COUNT(*) FROM device_data
      ) + (
        SELECT COUNT(*) FROM e2e_rooms
      ) AS cnt`)
      .get() as { cnt: number } | undefined;
    return Promise.resolve((row?.cnt ?? 0) > 0);
  }

  startup(): Promise<CryptoStore> {
    return Promise.resolve(this);
  }

  deleteAllData(): Promise<void> {
    this.db.exec(`
      DELETE FROM crypto_meta;
      DELETE FROM crypto_account;
      DELETE FROM cross_signing_keys;
      DELETE FROM secret_store_private_keys;
      DELETE FROM outgoing_room_key_requests;
      DELETE FROM end_to_end_sessions;
      DELETE FROM inbound_group_sessions;
      DELETE FROM device_data;
      DELETE FROM e2e_rooms;
    `);
    return Promise.resolve();
  }

  // ── Migration state ────────────────────────────────────────

  getMigrationState(): Promise<MigrationState> {
    const row = this.db
      .prepare(`SELECT value FROM crypto_meta WHERE key = ?`)
      .get('migrationState') as { value: string } | undefined;
    return Promise.resolve(
      row ? (Number(row.value) as MigrationState) : MigrationState.NOT_STARTED
    );
  }

  setMigrationState(migrationState: MigrationState): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO crypto_meta (key, value) VALUES ('migrationState', ?)`
      )
      .run(String(migrationState));
    return Promise.resolve();
  }

  // ── Outgoing room key requests ──────────────────────────────

  getOrAddOutgoingRoomKeyRequest(
    request: OutgoingRoomKeyRequest
  ): Promise<OutgoingRoomKeyRequest> {
    const existing = this.db
      .prepare(`SELECT * FROM outgoing_room_key_requests WHERE request_id = ?`)
      .get(request.requestId) as CryptoRequestRow | undefined;

    if (existing) {
      return Promise.resolve(rowToRequest(existing));
    }

    this.db
      .prepare(
        `
      INSERT INTO outgoing_room_key_requests (request_id, request_txn_id, recipients, request_body, state)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(
        request.requestId,
        request.requestTxnId ?? null,
        JSON.stringify(request.recipients),
        JSON.stringify(request.requestBody),
        request.state
      );
    return Promise.resolve(request);
  }

  getOutgoingRoomKeyRequest(
    requestBody: IRoomKeyRequestBody
  ): Promise<OutgoingRoomKeyRequest | null> {
    const bodyStr = JSON.stringify(requestBody);
    const rows = this.db
      .prepare(
        `SELECT * FROM outgoing_room_key_requests WHERE request_body = ?`
      )
      .all(bodyStr) as CryptoRequestRow[];
    return Promise.resolve(rows.length > 0 ? rowToRequest(rows[0]) : null);
  }

  getOutgoingRoomKeyRequestByState(
    wantedStates: number[]
  ): Promise<OutgoingRoomKeyRequest | null> {
    const placeholders = wantedStates.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM outgoing_room_key_requests WHERE state IN (${placeholders}) LIMIT 1`
      )
      .all(...wantedStates) as CryptoRequestRow[];
    return Promise.resolve(rows.length > 0 ? rowToRequest(rows[0]) : null);
  }

  getAllOutgoingRoomKeyRequestsByState(
    wantedState: number
  ): Promise<OutgoingRoomKeyRequest[]> {
    const rows = this.db
      .prepare(`SELECT * FROM outgoing_room_key_requests WHERE state = ?`)
      .all(wantedState) as CryptoRequestRow[];
    return Promise.resolve(rows.map(rowToRequest));
  }

  getOutgoingRoomKeyRequestsByTarget(
    userId: string,
    deviceId: string,
    wantedStates: number[]
  ): Promise<OutgoingRoomKeyRequest[]> {
    const placeholders = wantedStates.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT * FROM outgoing_room_key_requests WHERE state IN (${placeholders})`
      )
      .all(...wantedStates) as CryptoRequestRow[];
    // Filter in JS since recipients is a JSON array
    return Promise.resolve(
      rows
        .filter(r => {
          const recipients: IRoomKeyRequestRecipient[] = JSON.parse(
            r.recipients
          );
          return recipients.some(
            rr => rr.userId === userId && rr.deviceId === deviceId
          );
        })
        .map(rowToRequest)
    );
  }

  updateOutgoingRoomKeyRequest(
    requestId: string,
    expectedState: number,
    updates: Partial<OutgoingRoomKeyRequest>
  ): Promise<OutgoingRoomKeyRequest | null> {
    const existing = this.db
      .prepare(
        `SELECT * FROM outgoing_room_key_requests WHERE request_id = ? AND state = ?`
      )
      .get(requestId, expectedState) as CryptoRequestRow | undefined;
    if (!existing) return Promise.resolve(null);

    const merged = { ...rowToRequest(existing), ...updates };
    this.db
      .prepare(
        `
      UPDATE outgoing_room_key_requests
      SET request_txn_id = ?, recipients = ?, request_body = ?, state = ?
      WHERE request_id = ?
    `
      )
      .run(
        merged.requestTxnId ?? null,
        JSON.stringify(merged.recipients),
        JSON.stringify(merged.requestBody),
        merged.state,
        requestId
      );
    return Promise.resolve(merged);
  }

  deleteOutgoingRoomKeyRequest(
    requestId: string,
    expectedState: number
  ): Promise<OutgoingRoomKeyRequest | null> {
    const existing = this.db
      .prepare(
        `SELECT * FROM outgoing_room_key_requests WHERE request_id = ? AND state = ?`
      )
      .get(requestId, expectedState) as CryptoRequestRow | undefined;
    if (!existing) return Promise.resolve(null);
    this.db
      .prepare(`DELETE FROM outgoing_room_key_requests WHERE request_id = ?`)
      .run(requestId);
    return Promise.resolve(rowToRequest(existing));
  }

  // ── Account (pickled Olm account) ──────────────────────────

  getAccount(
    _txn: unknown,
    func: (accountPickle: string | null) => void
  ): void {
    const row = this.db
      .prepare(`SELECT pickle FROM crypto_account WHERE id = 1`)
      .get() as { pickle: string } | undefined;
    func(row?.pickle ?? null);
  }

  storeAccount(_txn: unknown, accountPickle: string): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO crypto_account (id, pickle) VALUES (1, ?)
    `
      )
      .run(accountPickle);
  }

  // ── Cross-signing keys ─────────────────────────────────────

  getCrossSigningKeys(
    _txn: unknown,
    func: (keys: Record<string, CrossSigningKeyInfo> | null) => void
  ): void {
    const row = this.db
      .prepare(`SELECT keys FROM cross_signing_keys LIMIT 1`)
      .get() as { keys: string } | undefined;
    func(row ? JSON.parse(row.keys) : null);
  }

  storeCrossSigningKeys(
    _txn: unknown,
    keys: Record<string, CrossSigningKeyInfo>
  ): void {
    this.db.prepare(`DELETE FROM cross_signing_keys`).run();
    this.db
      .prepare(`INSERT INTO cross_signing_keys (keys) VALUES (?)`)
      .run(JSON.stringify(keys));
  }

  // ── Secret store private keys ──────────────────────────────

  getSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
    _txn: unknown,
    func: (key: SecretStorePrivateKeys[K] | null) => void,
    type: K
  ): void {
    const row = this.db
      .prepare(`SELECT key FROM secret_store_private_keys WHERE type = ?`)
      .get(type as string) as { key: string } | undefined;
    func(row ? JSON.parse(row.key) : null);
  }

  storeSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
    _txn: unknown,
    type: K,
    key: SecretStorePrivateKeys[K]
  ): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO secret_store_private_keys (type, key) VALUES (?, ?)
    `
      )
      .run(type as string, JSON.stringify(key));
  }

  // ── End-to-end Olm sessions ────────────────────────────────

  countEndToEndSessions(_txn: unknown, func: (count: number) => void): void {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM end_to_end_sessions`)
      .get() as { cnt: number };
    func(row.cnt);
  }

  getEndToEndSession(
    deviceKey: string,
    sessionId: string,
    _txn: unknown,
    func: (session: ISessionInfo | null) => void
  ): void {
    const row = this.db
      .prepare(
        `SELECT * FROM end_to_end_sessions WHERE device_key = ? AND session_id = ?`
      )
      .get(deviceKey, sessionId) as E2eSessionRow | undefined;
    func(row ? rowToSessionInfo(row) : null);
  }

  getEndToEndSessions(
    deviceKey: string,
    _txn: unknown,
    func: (sessions: { [sessionId: string]: ISessionInfo }) => void
  ): void {
    const rows = this.db
      .prepare(`SELECT * FROM end_to_end_sessions WHERE device_key = ?`)
      .all(deviceKey) as E2eSessionRow[];
    const result: { [sessionId: string]: ISessionInfo } = {};
    for (const r of rows) {
      result[r.session_id] = rowToSessionInfo(r);
    }
    func(result);
  }

  storeEndToEndSession(
    deviceKey: string,
    sessionId: string,
    sessionInfo: ISessionInfo,
    _txn: unknown
  ): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO end_to_end_sessions (device_key, session_id, session, last_received_ts)
      VALUES (?, ?, ?, ?)
    `
      )
      .run(
        deviceKey,
        sessionId,
        sessionInfo.session ?? null,
        sessionInfo.lastReceivedMessageTs ?? null
      );
  }

  getEndToEndSessionsBatch(): Promise<ISessionInfo[] | null> {
    const rows = this.db
      .prepare(`SELECT * FROM end_to_end_sessions LIMIT ?`)
      .all(SESSION_BATCH_SIZE) as E2eSessionRow[];
    if (rows.length === 0) return Promise.resolve(null);
    return Promise.resolve(rows.map(rowToSessionInfo));
  }

  deleteEndToEndSessionsBatch(
    sessions: { deviceKey?: string; sessionId?: string }[]
  ): Promise<void> {
    const stmt = this.db.prepare(
      `DELETE FROM end_to_end_sessions WHERE device_key = ? AND session_id = ?`
    );
    for (const s of sessions) {
      if (s.deviceKey && s.sessionId) {
        stmt.run(s.deviceKey, s.sessionId);
      }
    }
    return Promise.resolve();
  }

  // ── Inbound (Megolm) group sessions ────────────────────────

  getEndToEndInboundGroupSession(
    senderCurve25519Key: string,
    sessionId: string,
    _txn: unknown,
    func: (
      groupSession: InboundGroupSessionData | null,
      groupSessionWithheld: IWithheld | null
    ) => void
  ): void {
    const row = this.db
      .prepare(
        `SELECT * FROM inbound_group_sessions WHERE sender_key = ? AND session_id = ?`
      )
      .get(senderCurve25519Key, sessionId) as InboundSessionRow | undefined;
    if (!row) {
      func(null, null);
      return;
    }
    const data = JSON.parse(row.session_data) as InboundGroupSessionData;
    // The withheld data is embedded in session_data if present
    const withheld: IWithheld | undefined = (
      data as InboundGroupSessionData & { withheld?: IWithheld }
    ).withheld;
    func(data, withheld ?? null);
  }

  storeEndToEndInboundGroupSession(
    senderCurve25519Key: string,
    sessionId: string,
    sessionData: InboundGroupSessionData,
    _txn: unknown
  ): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO inbound_group_sessions (sender_key, session_id, session_data, needs_backup)
      VALUES (?, ?, ?, 0)
    `
      )
      .run(senderCurve25519Key, sessionId, JSON.stringify(sessionData));
  }

  countEndToEndInboundGroupSessions(): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM inbound_group_sessions`)
      .get() as { cnt: number };
    return Promise.resolve(row.cnt);
  }

  getEndToEndInboundGroupSessionsBatch(): Promise<SessionExtended[] | null> {
    const rows = this.db
      .prepare(`SELECT * FROM inbound_group_sessions LIMIT ?`)
      .all(SESSION_BATCH_SIZE) as InboundSessionRow[];
    if (rows.length === 0) return Promise.resolve(null);
    return Promise.resolve(
      rows.map(r => ({
        senderKey: r.sender_key,
        sessionId: r.session_id,
        sessionData: JSON.parse(r.session_data),
        needsBackup: !!r.needs_backup,
      }))
    );
  }

  deleteEndToEndInboundGroupSessionsBatch(
    sessions: { senderKey: string; sessionId: string }[]
  ): Promise<void> {
    const stmt = this.db.prepare(
      `DELETE FROM inbound_group_sessions WHERE sender_key = ? AND session_id = ?`
    );
    for (const s of sessions) {
      stmt.run(s.senderKey, s.sessionId);
    }
    return Promise.resolve();
  }

  // ── Device data ────────────────────────────────────────────

  getEndToEndDeviceData(
    _txn: unknown,
    func: (deviceData: IDeviceData | null) => void
  ): void {
    const row = this.db
      .prepare(`SELECT device_data FROM device_data WHERE id = 1`)
      .get() as { device_data: string } | undefined;
    func(row ? JSON.parse(row.device_data) : null);
  }

  storeEndToEndDeviceData(deviceData: IDeviceData, _txn: unknown): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO device_data (id, device_data) VALUES (1, ?)
    `
      )
      .run(JSON.stringify(deviceData));
  }

  // ── E2EE rooms ─────────────────────────────────────────────

  storeEndToEndRoom(
    roomId: string,
    roomInfo: IRoomEncryption,
    _txn: unknown
  ): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO e2e_rooms (room_id, room_info) VALUES (?, ?)
    `
      )
      .run(roomId, JSON.stringify(roomInfo));
  }

  getEndToEndRooms(
    _txn: unknown,
    func: (rooms: Record<string, IRoomEncryption>) => void
  ): void {
    const rows = this.db.prepare(`SELECT * FROM e2e_rooms`).all() as {
      room_id: string;
      room_info: string;
    }[];
    const result: Record<string, IRoomEncryption> = {};
    for (const r of rows) {
      result[r.room_id] = JSON.parse(r.room_info);
    }
    func(result);
  }

  // ── Key backup ─────────────────────────────────────────────

  markSessionsNeedingBackup(
    sessions: ISession[],
    _txn?: unknown
  ): Promise<void> {
    const stmt = this.db.prepare(
      `UPDATE inbound_group_sessions SET needs_backup = 1 WHERE sender_key = ? AND session_id = ?`
    );
    for (const s of sessions) {
      stmt.run(s.senderKey, s.sessionId);
    }
    return Promise.resolve();
  }

  // ── Transaction helper ──────────────────────────────────────

  doTxn<T>(
    mode: Mode,
    stores: Iterable<string>,
    func: (txn: unknown) => T,
    _log?: Logger
  ): Promise<T> {
    // SQLite handles transactions natively; we pass null as the txn handle.
    return Promise.resolve(func(null));
  }
}

// ── Internal row types ────────────────────────────────────────

interface CryptoRequestRow {
  request_id: string;
  request_txn_id: string | null;
  recipients: string;
  request_body: string;
  state: number;
}

interface E2eSessionRow {
  device_key: string;
  session_id: string;
  session: string | null;
  last_received_ts: number | null;
}

interface InboundSessionRow {
  sender_key: string;
  session_id: string;
  session_data: string;
  needs_backup: number;
}

function rowToRequest(row: CryptoRequestRow): OutgoingRoomKeyRequest {
  return {
    requestId: row.request_id,
    requestTxnId: row.request_txn_id ?? undefined,
    cancellationTxnId: undefined,
    recipients: JSON.parse(row.recipients),
    requestBody: JSON.parse(row.request_body),
    state: row.state,
  };
}

function rowToSessionInfo(row: E2eSessionRow): ISessionInfo {
  return {
    deviceKey: row.device_key,
    sessionId: row.session_id,
    session: row.session ?? undefined,
    lastReceivedMessageTs: row.last_received_ts ?? undefined,
  };
}
