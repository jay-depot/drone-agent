---
tags: [decision, gateway, matrix, crypto, e2ee, drone-gateway, adr]
related:
  [
    modules/drone-gateway.md,
    decisions/059-matrix-adapter.md,
    decisions/062-gateway-sqlite-stores.md,
  ]
---

# 229 — Gateway Matrix crypto init is opt-in (no unconditional `initRustCrypto`)

**Status**: Implemented (2026-10-05) · **Branch**: `feat/gateway-swarm-console` · **Commit**: `ed9696da` · **Report**: DRONE-GW-BUG-001

**Summary**: `MatrixServiceAdapter.start()` called `client.initRustCrypto()` unconditionally. On a headless Node host, matrix-js-sdk@38 defaults `useIndexedDB` to `true`, so the Rust-crypto WASM reads the browser-only `indexedDB` global (undefined on Node) and **panics** — a `RuntimeError: unreachable` hard **abort** (exit 1) that no `try`/`catch` can intercept, turning a systemd `Restart=on-failure` unit into a crash loop. Encryption is now **opt-in** via a new `encryption` adapter-config field (default `false`), and when enabled it initializes crypto on the SDK's **in-memory** store (`useIndexedDB: false`), which works on Node.

## Why

- **Node has no `indexedDB`.** `typeof indexedDB === 'undefined'` in Node. The SDK's `initRustCrypto` defaults `useIndexedDB` to `true` (`lib/client.d.ts:1104`) and selects a non-null IndexedDB store prefix whenever `useIndexedDB !== false` (`lib/client.js:1087`). The IndexedDB-backed Rust store then calls the `indexedDB` getter, gets `null`, and panics inside the WASM module.
- **A WASM panic is an abort, not a JS exception.** `try`/`catch`, `--unhandled-rejections=warn`, and `NODE_OPTIONS` all fail to stop it. The failure therefore had to be _prevented_, not handled.
- **`cryptoStore` does not persist Rust-crypto keys.** Passing `SqliteCryptoStore` as `createClient({ cryptoStore })` is legacy-crypto / migration-only in v38 (`lib/client.d.ts:91-96`); the Rust-crypto stack ignores it. The old "keys persisted via SQLite" log message was therefore false for E2EE keys.

## Decision

- Add `encryption?: boolean` to `MatrixAdapterConfig` (default `false`). The config loader already passes unknown keys through (`config/load.ts` destructures only `type`), so no loader change was needed.
- `start()` calls a new `initCryptoForNode(client)` **only when `encryption` is truthy**. With encryption off, `initRustCrypto` is never called and the abort is impossible.
- `initCryptoForNode` calls `initRustCrypto({ useIndexedDB: false })` (the in-memory store) and surfaces any failure as a **descriptive error** — never a silent downgrade, never a panic.
- Correct the misleading log/doc claims: `dataPath` persists the **sync store** and backs the **legacy-crypto migration store**, not durable Rust-crypto E2EE keys.

## Consequences

- The recommended `dataPath` configuration (plan D10) now starts on any headless Node host; the crypto path is inert unless an operator opts in.
- When `encryption: true` is set, E2EE works but keys are **not durable** (in-memory store) — they are lost on restart. A SQLite-backed, Node-viable Rust-crypto store remains future work (would require SDK-level support).

## Validation

A **real-SDK** regression test (`test/matrix-adapter-real-sdk.test.ts`, no mock) loads the actual matrix-js-sdk and asserts the adapter starts without aborting and that `initRustCrypto` is **not** called when encryption is off; the mocked suite gained gating / in-memory-store / error-path cases. LSP clean; `pnpm -r run build`, `pnpm lint`, typecheck green; gateway suite 294 passed (was 288).

## Related

- [drone-gateway](../../drone-gateway/) — the Matrix adapter section.
- [059-matrix-adapter](059-matrix-adapter.md) — the adapter's original design.
- [062-gateway-sqlite-stores](062-gateway-sqlite-stores.md) — the SQLite store work whose crypto half this corrects.
- [230-gateway-sync-store-accumulation-and-replay-guard](230-gateway-sync-store-accumulation-and-replay-guard.md) — the follow-on sync-store fixes.
