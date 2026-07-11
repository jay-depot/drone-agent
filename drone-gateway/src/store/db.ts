import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../logger.js';

/**
 * Gateway SQLite database.
 *
 * A single .sqlite file (the adapter's `dataPath`) holds both the Matrix
 * sync store and the E2EE crypto store for that adapter. This mirrors how
 * drone-beacon / drone-coordinator persist their data via `better-sqlite3`,
 * and replaces the previous IndexedDBStore hack which silently fell back to
 * an in-memory store on a headless Node host (so everything was lost on
 * restart).
 *
 * All schema is created idempotently via CREATE TABLE IF NOT EXISTS.
 */

export type GatewayDatabase = Database.Database;

/**
 * Open (or create) the gateway database at `dataPath` and ensure the schema
 * exists. Parent directories are created as needed.
 */
export function openGatewayDb(dataPath: string): GatewayDatabase {
  logger.info({ dataPath }, 'Initializing gateway SQLite database');
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  const db = new Database(dataPath);
  initGatewaySchema(db);
  logger.info({ dataPath }, 'Gateway SQLite database ready');
  return db;
}

/**
 * Create all tables used by the gateway's Matrix stores.
 *
 * Split into crypto-store tables and sync-store tables so either store
 * implementation can rely on its own schema existing.
 */
export function initGatewaySchema(db: GatewayDatabase): void {
  createCryptoSchema(db);
  createSyncSchema(db);
}

/**
 * Crypto-store tables (legacy libolm `CryptoStore` interface).
 * Mirrors the object stores the SDK expects; serialized as TEXT blobs.
 */
function createCryptoSchema(db: GatewayDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crypto_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crypto_account (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pickle TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cross_signing_keys (
      keys TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secret_store_private_keys (
      type TEXT PRIMARY KEY,
      key TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outgoing_room_key_requests (
      request_id TEXT PRIMARY KEY,
      request_txn_id TEXT,
      recipients TEXT NOT NULL,
      request_body TEXT NOT NULL,
      state INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS end_to_end_sessions (
      device_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session TEXT NOT NULL,
      last_received_ts INTEGER,
      PRIMARY KEY (device_key, session_id)
    );

    CREATE TABLE IF NOT EXISTS inbound_group_sessions (
      sender_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_data TEXT NOT NULL,
      needs_backup INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (sender_key, session_id)
    );

    CREATE TABLE IF NOT EXISTS device_data (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      device_data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS e2e_rooms (
      room_id TEXT PRIMARY KEY,
      room_info TEXT NOT NULL
    );
  `);
}

/**
 * Sync-store tables.
 *
 * The sync store (like matrix-js-sdk's IndexedDBStore) keeps the live
 * Room/User objects in memory and only persists the raw saved-sync response,
 * presence events, out-of-band membership, pending events, to-device
 * batches, client options, and the sync token. On startup the client replays
 * the saved sync to rebuild in-memory state.
 */
function createSyncSchema(db: GatewayDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_sync (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sync_token TEXT NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS presence_events (
      user_id TEXT PRIMARY KEY,
      event TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oob_members (
      room_id TEXT PRIMARY KEY,
      events TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_events (
      room_id TEXT PRIMARY KEY,
      events TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS to_device_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      txn_id TEXT NOT NULL,
      batch TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS client_options (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      options TEXT NOT NULL
    );
  `);
}
