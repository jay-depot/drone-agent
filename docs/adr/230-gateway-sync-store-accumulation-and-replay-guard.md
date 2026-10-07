---
tags: [decision, gateway, matrix, sync, persistence, drone-gateway, adr]
related: [modules/drone-gateway.md, decisions/229-gateway-matrix-crypto-opt-in.md, decisions/059-matrix-adapter.md, decisions/062-gateway-sqlite-stores.md]
---

# 230 — Gateway sync store accumulates state; the adapter ignores replayed cached-sync events

**Status**: Implemented (2026-10-05) · **Branch**: `feat/gateway-swarm-console` · **Commits**: `ef285a94`, `3706080d` · **Reports**: DRONE-GW-BUG-002 (+ follow-on)

**Summary**: Two coupled fixes to the gateway's persistent Matrix sync store. (1) `SqliteSyncStore.setSyncData()` persisted each `/sync` response with `INSERT OR REPLACE` against one row — but a `/sync` response is a **delta**, so the stored blob became a bare delta with a valid token and no `rooms`, and a restarted client resumed an incremental sync with an empty room list and could not reply. The store now folds every response into a **`SyncAccumulator`** and persists the *accumulated* state. (2) With a persisted token, the SDK **replays the cached `/sync`** on restart and re-emits each cached timeline event as `RoomEvent.Timeline` — and the adapter, filtering only on `toStartOfTimeline`, re-dispatched historical commands as if they were new input. The handler now drops anything that is not a live event (`removed || !data?.liveEvent`).

## Why (1) — the clobber

The SDK's own IndexedDB backend keeps a `SyncAccumulator` and folds every response into it (`setSyncData` → `accumulate`; `getSavedSync` → `getJSON()`). The gateway re-implemented the store but dropped the accumulator, storing "the last response" instead of "the accumulated state". Failure chain: initial sync writes the room, the next incremental sync (token only) **overwrites** it, the saved token still points past the room, the client resumes incrementally and never re-syncs the room list. `getRooms()` is empty, so `resolveDmRoom` finds no 2-member room and `sendMessage` fails with `unknown conversation` — one-way chat, strictly worse than having no store (which would force a full sync each start).

## Why (2) — the replay

Once the store persists room history with a valid token, on every restart `syncFromCache` → `processSyncResponse(fromCache:true)` re-emits cached timeline events. `EventTimelineSet.addLiveEvent` **always** emits with `toStartOfTimeline === false` (it only ever adds to the live timeline), so that flag cannot distinguish replay; the discriminator is `data.liveEvent === false` (`liveEvent = !toStartOfTimeline && timeline == liveTimeline && !fromCache`). Filtering on `toStartOfTimeline` alone re-dispatched an old command as fresh input: its answer "answered" a later unrelated command (`swarm.session.list` got the `swarm.beacon.list` reply) and each restart re-fired the cached commands once (4× over 3 restarts).

## Decision

- `SqliteSyncStore` holds a `SyncAccumulator`. `setSyncData` accumulates and persists `getJSON(true)`; `getSavedSync`/`getSavedSyncToken` read `getJSON()`/`getNextBatchToken()`. Rehydration is **lazy and concurrency-safe** (the adapter reads the DB directly and never awaited `startup()`): the accumulator is replayed once from persisted state via `accumulate(..., fromDatabase=true)`. Legacy rows written by the old clobbering store are read best-effort so a single full sync heals them; `deleteAllData()` resets the accumulator.
- The `MatrixServiceAdapter` timeline handler takes the full SDK signature `(event, room, toStartOfTimeline, removed, data)` and returns early on `removed || !data?.liveEvent` — the SDK's own documented check — ignoring backlog, replayed cached sync, and redactions.
- `db.ts`'s schema comment now states the row holds **accumulated** state.

## Consequences

- A restarted gateway keeps its rooms and can resolve `dm:@peer:server` → reply. A deployment whose database was already poisoned by the old store needs a one-off `DELETE FROM saved_sync` so the client performs one full sync; no longer required after the fix.
- The stored `saved_sync` row is now the serialized `ISyncData` (`nextBatch`/`roomsData`/`accountData`); legacy raw-`/sync` rows are still accepted on read.
- With a persistent store, `RoomEvent.Timeline` must be treated as "timeline changed", not "new message" — gate on `data.liveEvent`.

## Validation

- `test/sqlite-sync-store.test.ts` — accumulate-across-incremental-syncs, rehydrate into a fresh store over the same db, legacy raw-row read.
- **`test/sync-store-resume.test.ts`** — real `MatrixClient` (no mock), `start → sync → restart → sync`, asserts `getSavedSync().roomsData` still lists the room and `getRooms()` is non-empty; fails on the old store.
- **`test/matrix-adapter-replay.test.ts`** — real client over a seeded store, asserts a cached command is **not** re-dispatched; fails on the old handler.
- `test/fixtures/sync.ts` — shared room/incremental/message sync builders.
- LSP clean; `pnpm -r run build`, `pnpm lint` green; gateway suite 299 → 302 passed.

## Related

- [drone-gateway](../../drone-gateway/) — the Matrix adapter + store sections.
- [229-gateway-matrix-crypto-opt-in](229-gateway-matrix-crypto-opt-in.md) — the crypto half of the same bug-fix arc.
- [059-matrix-adapter](059-matrix-adapter.md) — the adapter's original design.
- [062-gateway-sqlite-stores](062-gateway-sqlite-stores.md) — the store work these fixes correct.
