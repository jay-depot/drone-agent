---
key: gateway-sqlite-stores-plan
tags:
  - gateway
  - matrix
  - sqlite
  - plan
  - e2ee
created: 2026-07-08T21:33:38.139Z
updated: 2026-07-08T21:33:38.139Z
---

# Plan: Gateway SQLite-backed Matrix stores + coordinatorUrl warning

## Why

The gateway's Matrix adapter cannot persist data on a headless Pi:

- E2EE keys: `createClient` is never given a `cryptoStore`, so `initCrypto()` (legacy libolm path,
  client.js:1042) would throw "Cannot enable encryption: no cryptoStore provided"; keys are in-memory →
  can't decrypt messages after restart.
- Sync store: `dataPath` feeds `IndexedDBStore` (matrix.ts:312-344) which needs a browser `indexedDB`
  global → throws on Node → silently falls back to volatile `MemoryStore` → full resync every restart.
  SDK ships only Memory/LocalStorage/IndexedDB stores; no Node SQLite store. Rust crypto (`initRustCrypto`)
  keeps its store inside a WASM blob → no JS hook to back with SQLite. So the ONLY way to get persistence on
  Node is to implement the legacy `CryptoStore` (~40 methods, crypto/store/base.d.ts) and the sync `Store`
  (~38 methods, store/index.d.ts) over `better-sqlite3`, mirroring beacon/coordinator's `initDatabase()`.

## Scope (agreed)

- A: implement BOTH `SqliteCryptoStore` and `SqliteSyncStore`, one .sqlite file per adapter (dataPath = file path).
- coordinatorUrl: warn when missing in local mode; still THROW when spawnBackend==='coordinator' (stopgap;
  user wants a graceful degradation chain later — captured as insight `gateway-config`).

## Steps (ordered)

S0 Deps+scaffold (coder):

- package.json: add better-sqlite3 ^11.8.1 + @types/better-sqlite3 ^7.6.13 (mirror beacon). pnpm install.
- src/store/db.ts: openGatewayDb(dataPath) + initGatewaySchema(db) creating all crypto+sync tables
  (mkdir dirname, new Database, db.exec CREATE TABLE IF NOT EXISTS — match db/init.ts style).
- Delete src/matrix-store.d.ts (dead ambient decls for removed IndexedDB/Memory subpaths).

S1 SqliteCryptoStore (coder): src/store/sqlite-crypto-store.ts implements CryptoStore.
Tables: meta, crypto_account, cross_signing_keys, secret_store_private_keys,
outgoing_room_key_requests, end_to_end_sessions (PK deviceKey,sessionId), session_problems,
inbound_group_sessions (PK senderKey,sessionId; needsBackup col), device_data, e2e_rooms,
shared_history, parked_shared_history.

- callback-style (txn,func)=>void methods: ignore txn, call func(value).
- doTxn<T>(mode,stores,func,log): return Promise.resolve(func(null)).
- batch methods: LIMIT 50 (SESSION_BATCH_SIZE).
- containsData(): any rows; startup(): resolve(this); deleteAllData(): DELETE all.

S2 SqliteSyncStore (coder): src/store/sqlite-sync-store.ts implements Store.
Tables: sync_meta, rooms, users, room_events (PK roomId,eventId), room_summaries, account_data,
filters, filter_names, saved_sync, oob_members, to_device_batches (autoincrement id), pending_events.

- Serialize Room/User/MatrixEvent via .toJSON(); reconstruct via Room.fromJSON / MatrixEvent /
  User constructors (verify exact reconstruction API during impl).
- save()/wantsSave(): no-op durable flush. startup/destroy: resolve/no-op. ~38 methods.

S3 Wire into adapter (coder): src/adapters/matrix.ts

- Remove getStore() IndexedDB/Memory hack.
- start(): if dataPath → openGatewayDb + new SqliteCryptoStore(db) + new SqliteSyncStore(db), pass both
  to createClient({..., store, cryptoStore}); else omit (legacy in-memory preserved).
- Keep initCrypto() try/catch warn (message: E2EE now persists on Node via SQLite; if olm missing, degrade
  to plaintext).
- stop(): close db after client.stopClient(); NEVER delete dataPath.

S4 coordinatorUrl warning (coder): src/config/load.ts

- Move spawnBackend resolution above the coordinatorUrl check.
- Missing/non-string coordinatorUrl: if spawnBackend==='coordinator' throw (clarify msg); else logger.warn.

S5 Docs (coder): update CONTEXT.md dataPath note (sqlite file), wiki modules/drone-gateway.md Matrix Adapter
section (E2EE now persists on Node), update memory matrix-gateway-raspberry-pi-gaps Gap#1.

S6 Tests (tester): sqlite-crypto-store.test.ts, sqlite-sync-store.test.ts (round-trips, tmp db);
config-load.test.ts (missing coordinatorUrl + local = no throw; + coordinator = throws);
matrix-adapter.test.ts (add dataPath case asserting store+cryptoStore passed, tmp .sqlite created/closed).

S7 Validate: pnpm typecheck clean; pnpm lint clean; pnpm -C drone-gateway test green; (optional smoke:
build, run with matrix adapter dataPath, restart, confirm decryption).

## Agent assignment

coder: S0–S5. tester: S6. reviewer: review S1/S2 interface conformance + S3 wiring. All: S7 criteria.

## Validation criteria

- pnpm typecheck (all packages) clean.
- LSP diagnostics clean for drone-gateway.
- pnpm lint clean.
- vitest (drone-gateway) green.
- (manual) gateway starts, .sqlite created at dataPath, survives restart with E2EE working.
