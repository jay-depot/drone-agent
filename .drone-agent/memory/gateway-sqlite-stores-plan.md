---
key: gateway-sqlite-stores-plan
tags:
  - gateway
  - matrix
  - sqlite
  - plan
  - e2ee
  - executed
created: 2026-07-08T21:33:38.139Z
updated: 2026-07-08T22:00:06.013Z
---

# Plan: Gateway SQLite-backed Matrix stores + coordinatorUrl warning

## Status: EXECUTED 2026-07-08 (commit cbe9fb6)

## Summary of work completed

### S0 Deps+scaffold

- Added `better-sqlite3 ^11.8.1` + `@types/better-sqlite3 ^7.6.13` to drone-gateway/package.json
- Created `src/store/db.ts` with `openGatewayDb()` + `initGatewaySchema()` — all crypto+sync tables
- Deleted `src/matrix-store.d.ts` (dead ambient decls for removed IndexedDB/Memory subpaths)

### S1 SqliteCryptoStore

- `src/store/sqlite-crypto-store.ts` — implements the full `CryptoStore` interface (~40 methods)
- Tables: crypto_meta, crypto_account, cross_signing_keys, secret_store_private_keys,
  outgoing_room_key_requests, end_to_end_sessions, session_problems, inbound_group_sessions,
  device_data, e2e_rooms, shared_history, parked_shared_history
- Callback-style methods ignore `_txn` (SQLite handles transactions natively)
- `doTxn` passes null as txn handle
- Batch methods use LIMIT 50 (SESSION_BATCH_SIZE)
- `containsData` checks all tables

### S2 SqliteSyncStore

- `src/store/sqlite-sync-store.ts` — extends `MemoryStore` (same as IndexedDBStore)
- Persists: saved sync (ISyncResponse → ISavedSync with next_batch→nextBatch transform),
  presence events, OOB members, pending events, to-device batches, client options
- `syncTs` initialized to `Date.now()` so `wantsSave()` returns false initially
- `startup()` replays presence events into MemoryStore

### S3 Wire into adapter

- `src/adapters/matrix.ts` — removed `getStore()` IndexedDB/Memory hack
- When `dataPath` is set: `openGatewayDb` → `SqliteSyncStore` + `SqliteCryptoStore` → pass to `createClient`
- `stop()` closes the SQLite database after `client.stopClient()`; never deletes dataPath
- Import `ICreateClientOpts` for proper typing

### S4 coordinatorUrl warning

- `src/config/load.ts` — moved spawnBackend resolution above coordinatorUrl check
- Missing coordinatorUrl: warn in local mode, throw when spawnBackend==='coordinator'
- Defaults to empty string when missing

### S5 Docs

- `CONTEXT.md` — updated config layout (coordinatorUrl optional for local, dataPath = SQLite)
- Wiki `modules/drone-gateway.md` — added store files, updated Matrix Adapter section
- `matrix-gateway-raspberry-pi-gaps` — marked Gap #1 as CLOSED, Gap #3 as CLOSED

### S6 Tests

- `test/sqlite-crypto-store.test.ts` — 30+ tests covering lifecycle, migration, account,
  cross-signing keys, outgoing requests, Olm sessions, inbound group sessions, E2EE rooms,
  device data, shared history, doTxn
- `test/sqlite-sync-store.test.ts` — 15+ tests covering lifecycle, saved sync, OOB members,
  client options, pending events, to-device batches, deleteAllData, save/wantsSave
- `test/config-load.test.ts` — added 4 coordinatorUrl validation tests
- `test/matrix-adapter.test.ts` — updated mocks (SQLite stores instead of IndexedDB/Memory),
  added dataPath wiring tests (opens db, passes stores, closes on stop)

### S7 Validation

- `pnpm -C drone-gateway typecheck` — clean
- `pnpm lint` — clean for drone-gateway (pre-existing JSON syntax error in git-plugin insight)
- `npx vitest run drone-gateway/test/` — 160 tests, 12 files, all passing
- ESLint config updated: `argsIgnorePattern: '^_'` and `varsIgnorePattern: '^_'` for unused params

## Key deviation from plan

- S2 originally planned to serialize Room/User via .toJSON()/fromJSON(). This is impossible
  in matrix-js-sdk v34 (no Room.fromJSON). Instead, SqliteSyncStore extends MemoryStore and
  persists the same things IndexedDBStore does: saved sync blob, presence events, OOB members,
  pending events, to-device batches, client options. On startup the client replays the saved
  sync to rebuild live objects in memory.
