---
tags: [decision, gateway, ci]
related: [modules/drone-gateway.md, decisions/062-gateway-sqlite-stores.md]
---

# ADR 063: Fix drone-gateway Build + Add typecheck to CI

**Status**: Implemented 2026-07-11

## Context

Two issues:

1. **CI gap**: The `unit-tests` job in `.github/workflows/integration-test.yml` ran `pnpm test` (vitest) and `pnpm lint`, but NOT `pnpm typecheck`. Since vitest uses esbuild (not tsc) to transpile, TypeScript compilation errors pass through undetected. This allowed the drone-gateway build to break without CI catching it.

2. **drone-gateway build failure**: `matrix-js-sdk` v38 reorganized its crypto internals. The `SqliteCryptoStore` and `MatrixServiceAdapter` were written for an older version. Three categories of fix needed:
   - `initCrypto()` → `initRustCrypto()` in `matrix.ts`
   - Fix imports in `sqlite-crypto-store.ts` that reference removed module paths
   - Remove methods/types from `SqliteCryptoStore` that were removed from the v38 `CryptoStore` interface

## Decision

### 1. Add typecheck to CI

Add a `pnpm typecheck` step to the `unit-tests` job, between "Install dependencies" and "Run unit tests". This runs `tsc -b` across all workspace packages, catching TypeScript errors on every push/PR.

### 2. Fix matrix.ts — `initCrypto()` → `initRustCrypto()`

The v38 SDK only supports the Rust-based crypto backend. Changed `await this.client.initCrypto()` to `await this.client.initRustCrypto()`. The no-arg call still works.

### 3. Fix imports in sqlite-crypto-store.ts

The following types moved to `.../crypto/store/base.js` in v38:
- `InboundGroupSessionData` (was `.../crypto/OlmDevice.js`)
- `IRoomEncryption` (was `.../crypto/RoomList.js`)
- `IRoomKeyRequestBody` (was `.../crypto/index.js`)
- `IRoomKeyRequestRecipient` (was `.../crypto/index.js`)

### 4. Remove dead methods from SqliteCryptoStore

The following methods were removed from the v38 `CryptoStore` interface and are now dead code:
- `storeEndToEndSessionProblem` / `getEndToEndSessionProblem` (and `IProblem` type)
- `filterOutNotifiedErrorDevices` (and `IOlmDevice` type)
- `getAllEndToEndSessions`
- `addEndToEndInboundGroupSession`
- `storeEndToEndInboundGroupSessionWithheld`
- `getAllEndToEndInboundGroupSessions`
- `addSharedHistoryInboundGroupSession` / `getSharedHistoryInboundGroupSessions`
- `addParkedSharedHistory` / `takeParkedSharedHistory` (and `ParkedSharedHistory` type)
- `getSessionsNeedingBackup` / `countSessionsNeedingBackup` / `unmarkSessionsNeedingBackup`

Also removed the associated SQL tables from the schema in `db.ts`:
- `session_problems`
- `shared_history`
- `parked_shared_history`

## Consequences

- **Positive**: CI now catches TypeScript errors on every push/PR via `pnpm typecheck`.
- **Positive**: The drone-gateway builds cleanly against matrix-js-sdk v38.
- **Positive**: 13 dead methods and 3 unused types removed from the codebase.
- **Positive**: 3 unused SQL tables removed from the schema.
- **Neutral**: The `initRustCrypto()` call is the only supported path in v38 — no fallback to `initCrypto()`.

## Files Changed

- `.github/workflows/integration-test.yml` — Added `pnpm typecheck` step
- `drone-gateway/src/adapters/matrix.ts` — `initCrypto()` → `initRustCrypto()`
- `drone-gateway/src/store/sqlite-crypto-store.ts` — Fixed imports, removed 13 dead methods, removed 3 unused types
- `drone-gateway/src/store/db.ts` — Removed `session_problems`, `shared_history`, `parked_shared_history` tables
- `drone-gateway/test/sqlite-crypto-store.test.ts` — Fixed imports, removed shared history tests
- `drone-gateway/test/matrix-adapter.test.ts` — Renamed mock to `mockInitRustCrypto`

## Related

- [[decisions/062-gateway-sqlite-stores]] — The SQLite stores that needed the v38 fixes
- [[modules/drone-gateway]] — Gateway module overview
