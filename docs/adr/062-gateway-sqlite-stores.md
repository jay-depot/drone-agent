---
tags: [decision, gateway, matrix, sqlite]
related: [modules/drone-gateway.md, decisions/059-matrix-adapter.md, decisions/058-gateway-config-model.md]
---

# ADR 062: SQLite-Backed Matrix Stores for Headless E2EE

**Status**: Implemented 2026-07-08

## Context

The drone-gateway's Matrix adapter needs persistent E2EE key storage to survive restarts on headless Node.js hosts. The `matrix-js-sdk` v34+ supports pluggable `CryptoStore` and `SyncStore` implementations, but the only built-in options are:

- **IndexedDBStore** — browser-only (requires `window.indexedDB`)
- **MemoryStore** — in-memory only (loses all state on restart)

On a headless Node.js server (e.g., Raspberry Pi), neither works. The adapter silently fell back to `MemoryStore`, meaning every restart required a full sync and lost E2EE keys — making encrypted rooms unusable.

## Decision

Create two SQLite-backed store implementations using `better-sqlite3`:

### SqliteCryptoStore

Implements the full `CryptoStore` interface (~40 methods) over a single SQLite database:

- **Tables**: `crypto_meta`, `crypto_account`, `cross_signing_keys`, `secret_store_private_keys`, `outgoing_room_key_requests`, `end_to_end_sessions`, `inbound_group_sessions`, `device_data`, `e2e_rooms`
- **Callback-style methods**: ignore the `_txn` parameter (SQLite handles transactions natively)
- **`doTxn`**: passes `null` as the txn handle (callbacks receive `null` and operate directly on the db)
- **Batch methods**: use `LIMIT 50` (`SESSION_BATCH_SIZE`)
- **`containsData`**: checks all tables for any rows

### SqliteSyncStore

Extends `MemoryStore` (same pattern as `IndexedDBStore`) with SQLite persistence:

- Persists: saved sync (`ISyncResponse` → `ISavedSync` with `next_batch`→`nextBatch` transform), presence events, OOB members, pending events, to-device batches, client options
- **`syncTs`**: initialized to `Date.now()` so `wantsSave()` returns `false` initially (avoids unnecessary saves)
- **`startup()`**: replays presence events into the in-memory `MemoryStore`

### Wiring

When `dataPath` is set in the adapter config:

1. `openGatewayDb()` creates/opens a SQLite database at `<dataPath>/gateway.db`
2. `initGatewaySchema()` creates all tables
3. Both stores are instantiated with the same `db` instance
4. Passed to `matrix-js-sdk`'s `createClient()` via `ICreateClientOpts`
5. On `stop()`, the SQLite database is closed after `client.stopClient()` flushes

### coordinatorUrl Warning

The `coordinatorUrl` config field was previously required even in local spawn mode. Now:

- Missing `coordinatorUrl`: warns in local mode, only throws when `spawnBackend === 'coordinator'`
- Defaults to empty string when missing

## Consequences

- **Positive**: E2EE keys survive restarts on headless Node.js hosts. Encrypted rooms work persistently.
- **Positive**: Sync state survives restarts — no full re-sync on every restart.
- **Positive**: Single `.sqlite` file per adapter — easy to back up, clean up, or inspect.
- **Positive**: `coordinatorUrl` is no longer required for local-only deployments.
- **Neutral**: The `SqliteSyncStore` extends `MemoryStore` rather than implementing a full `ISyncStore` from scratch. This means it inherits `MemoryStore`'s in-memory data structures and persists the same fields `IndexedDBStore` does.
- **Neutral**: `doTxn` passes `null` as the txn handle. This is compatible with the SDK's callback pattern because callbacks receive `null` and operate directly on the database.

## Key Deviation from Original Plan

The plan originally proposed serializing `Room`/`User` objects via `.toJSON()`/`fromJSON()`. This is impossible in `matrix-js-sdk` v34 (no `Room.fromJSON`). Instead, `SqliteSyncStore` extends `MemoryStore` and persists the same things `IndexedDBStore` does: saved sync blob, presence events, OOB members, pending events, to-device batches, client options. On startup, the client replays the saved sync to rebuild live objects in memory.

## Files Changed

- `drone-gateway/src/store/db.ts` — `openGatewayDb()` + `initGatewaySchema()`
- `drone-gateway/src/store/sqlite-crypto-store.ts` — Full `CryptoStore` implementation
- `drone-gateway/src/store/sqlite-sync-store.ts` — `MemoryStore`-extending sync store
- `drone-gateway/src/adapters/matrix.ts` — Wire stores when `dataPath` is set
- `drone-gateway/src/config/load.ts` — `coordinatorUrl` warning/throw logic
- `drone-gateway/src/matrix-store.d.ts` — Deleted (dead ambient decls)
- `drone-gateway/package.json` — Added `better-sqlite3` + `@types/better-sqlite3`
- `drone-gateway/test/sqlite-crypto-store.test.ts` — 30+ tests
- `drone-gateway/test/sqlite-sync-store.test.ts` — 15+ tests
- `drone-gateway/test/config-load.test.ts` — 4 coordinatorUrl validation tests
- `drone-gateway/test/matrix-adapter.test.ts` — Updated mocks + dataPath wiring tests

## Related

- [drone-gateway](../../drone-gateway/) — Gateway module overview
- [059-matrix-adapter](059-matrix-adapter.md) — Matrix adapter design
- [058-gateway-config-model](058-gateway-config-model.md) — Config model refactor
- matrix-gateway-raspberry-pi-gaps — Gap #1 (persistent E2EE store) closed by this ADR
