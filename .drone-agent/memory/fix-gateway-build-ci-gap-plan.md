---
key: fix-gateway-build-ci-gap-plan
tags:
  - plan
  - drone-gateway
  - ci
  - build-fix
created: 2026-07-11T18:15:13.383Z
updated: 2026-07-11T18:20:01.185Z
---

# Plan: Fix drone-gateway build + CI gap

## Summary

Two issues to fix:

1. **CI gap**: The `unit-tests` job in `.github/workflows/integration-test.yml` runs `pnpm test` (vitest) and `pnpm lint`, but NOT `pnpm typecheck`. Since vitest uses esbuild (not tsc) to transpile, TypeScript compilation errors pass through undetected. Adding `pnpm typecheck` catches them cheaply on every push/PR.

2. **drone-gateway build failure**: `matrix-js-sdk` v38 reorganized its crypto internals. The `SqliteCryptoStore` and `MatrixServiceAdapter` were written for an older version. Three categories of fix needed:
   - `initCrypto()` → `initRustCrypto()` in `matrix.ts`
   - Fix imports in `sqlite-crypto-store.ts` that reference removed module paths
   - Remove methods/types from `SqliteCryptoStore` that were removed from the v38 `CryptoStore` interface (they're dead code now)
   - Update the test files to match

## Step-by-step plan

### Step 1: Fix CI pipeline (coder)
**File:** `.github/workflows/integration-test.yml`

Add a `pnpm typecheck` step to the `unit-tests` job, between "Install dependencies" and "Run unit tests":

```yaml
      - name: Typecheck
        run: pnpm typecheck
```

This runs `tsc -b` across all workspace packages, which would catch the drone-gateway errors immediately.

### Step 2: Fix `matrix.ts` — rename `initCrypto()` to `initRustCrypto()` (coder)
**File:** `drone-gateway/src/adapters/matrix.ts`, line 131

Change:
```typescript
await this.client.initCrypto();
```
To:
```typescript
await this.client.initRustCrypto();
```

The v38 SDK only supports the Rust-based crypto backend. The method signature changed — `initRustCrypto()` takes `{ useIndexedDB?, cryptoDatabasePrefix?, storageKey?, storagePassword? }` — but since we're calling it with no args (best-effort), the no-arg call still works.

### Step 3: Fix imports in `sqlite-crypto-store.ts` (coder)
**File:** `drone-gateway/src/store/sqlite-crypto-store.ts`

The following types are still exported from `.../crypto/store/base.js` and just need their import paths fixed:
- `InboundGroupSessionData` — was imported from `.../crypto/OlmDevice.js`, now available from `.../crypto/store/base.js`
- `IRoomEncryption` — was imported from `.../crypto/RoomList.js`, now available from `.../crypto/store/base.js`
- `IRoomKeyRequestBody` — was imported from `.../crypto/index.js`, now available from `.../crypto/store/base.js`
- `IRoomKeyRequestRecipient` — was imported from `.../crypto/index.js`, now available from `.../crypto/store/base.js`

The following types were **removed** from v38's `CryptoStore` interface:
- `IProblem` — remove the import and the `storeEndToEndSessionProblem`/`getEndToEndSessionProblem` methods
- `ParkedSharedHistory` — remove the import and the `addParkedSharedHistory`/`takeParkedSharedHistory` methods

The following type was used only by a method removed from the interface:
- `IOlmDevice` — remove the import and the `filterOutNotifiedErrorDevices` method

The following methods are no longer part of the `CryptoStore` interface and should be removed:
- `storeEndToEndSessionProblem`
- `getEndToEndSessionProblem`
- `filterOutNotifiedErrorDevices`
- `getAllEndToEndSessions`
- `addEndToEndInboundGroupSession`
- `storeEndToEndInboundGroupSessionWithheld`
- `getAllEndToEndInboundGroupSessions`
- `addSharedHistoryInboundGroupSession`
- `getSharedHistoryInboundGroupSessions`
- `addParkedSharedHistory`
- `takeParkedSharedHistory`
- `getSessionsNeedingBackup`
- `countSessionsNeedingBackup`
- `unmarkSessionsNeedingBackup`

Also remove the associated SQL tables from the schema if they exist (in `db.ts`).

### Step 4: Update test file `sqlite-crypto-store.test.ts` (coder)
**File:** `drone-gateway/test/sqlite-crypto-store.test.ts`

Fix imports to match the new import paths, and remove test cases for methods that were removed from the `CryptoStore` interface:
- Remove `IProblem` import
- Remove `ParkedSharedHistory` import
- Remove `InboundGroupSessionData` import from `.../crypto/OlmDevice.js` — import from `.../crypto/store/base.js` instead
- Remove `IRoomEncryption` import from `.../crypto/RoomList.js` — import from `.../crypto/store/base.js` instead
- Remove the "shared history" describe block
- Remove the `InboundGroupSessionData` type import from the old path

### Step 5: Update test file `matrix-adapter.test.ts` (coder)
**File:** `drone-gateway/test/matrix-adapter.test.ts`

Rename `mockInitCrypto` to `mockInitRustCrypto` and update all references.

### Step 6: Verify the build (tester)
Run `pnpm typecheck` and `pnpm build` to confirm all errors are resolved.

### Step 7: Verify tests pass (tester)
Run `pnpm test` to confirm all tests still pass.

## Validation criteria
- [x] `pnpm typecheck` passes with zero errors (drone-gateway typecheck: Done)
- [x] `pnpm build` passes with zero errors (drone-gateway build: Done)
- [x] `pnpm test` passes with zero failures (96 test files, 1399 tests passed)
- [x] The CI pipeline's `unit-tests` job includes a `pnpm typecheck` step
- [x] All removed methods are confirmed dead code (not called anywhere else in the codebase)

## Work completed
- **2026-07-11**: Implemented by drone-agent coder persona. All 7 steps completed successfully.
  - CI pipeline updated with `pnpm typecheck` step
  - `matrix.ts`: `initCrypto()` → `initRustCrypto()`
  - `sqlite-crypto-store.ts`: Fixed imports, removed 13 dead methods, removed 3 unused types
  - `db.ts`: Removed `session_problems`, `shared_history`, `parked_shared_history` tables
  - `sqlite-crypto-store.test.ts`: Fixed imports, removed shared history tests
  - `matrix-adapter.test.ts`: Renamed mock to `mockInitRustCrypto`
  - All builds and tests pass