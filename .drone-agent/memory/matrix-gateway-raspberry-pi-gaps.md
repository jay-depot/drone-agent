---
key: matrix-gateway-raspberry-pi-gaps
tags:
  - gateway
  - matrix
  - raspberry-pi
  - gap
  - setup
created: 2026-07-08T21:21:06.718Z
updated: 2026-08-13T21:50:02.312Z
---

How to stand up a Matrix chatbot on a Pi using drone-gateway (standalone/local spawn backend, no beacon/coordinator needed):

PIPELINE:

- drone-gateway (src/index.ts `serve`) loads ~/.drone-gateway/config.json + adapters/_/adapter.json + adapters/_/conversations/\*.json (CONTEXT.md, config/load.ts).
- MatrixServiceAdapter (src/adapters/matrix.ts) connects via matrix-js-sdk. DM = rooms with <=2 members -> convId `dm:@peer:server`; rooms use roomId; allowlist via `rooms[]` (DMs always included).
- Per-conversation control surfaces: `persona-assignment` spawns `drone-agent --output-json --persona <id>` via LocalSpawnBackend (local-spawn-backend.ts) and returns the reply. `discard` = /dev/null (good for wildcard `_default_.json`).
- Replies: markdown->HTML (BasicMarkdownRenderer), read receipts, typing.

GAPS THAT CANNOT BE CLOSED WITH SHELL/SYSTEMD ALONE:

1. [PARTIAL 2026-10-05] PERSISTENT STORES ON NODE: When dataPath is set, the SYNC store (room timelines, sync token) is backed by SqliteSyncStore over better-sqlite3, so the bot survives restarts without re-syncing.
   CORRECTION: the 2026-07-08 claim that this also makes E2EE keys survive restart was WRONG. matrix-js-sdk@38 treats `cryptoStore` (where SqliteCryptoStore is passed) as legacy-crypto / migration only; the Rust-crypto stack ignores it. dataPath backs the legacy-crypto migration store, NOT durable Rust-crypto E2EE keys.
   Also fixed 2026-10-05: the adapter used to call `client.initRustCrypto()` unconditionally, which selects an IndexedDB store by default and PANICS in the WASM module on Node (`indexedDB` is undefined) — a hard abort (exit 1) that try/catch cannot catch; under systemd this is a crash loop. Crypto init is now opt-in via `adapter.json encryption: true` (default false); when enabled it uses the in-memory store (`useIndexedDB:false`, works on Node, keys NOT durable). A real-SDK regression test (no mock) now guards this.
2. NO LOGIN/TOKEN FLOW: adapter.json requires a pre-made `accessToken` (matrix.ts:62-69). There is no login/registration/refresh in code. Partially scriptable: `curl -XPOST $homeserver/_matrix/client/v3/login` with password returns an access_token, but no refresh/rotation is implemented (password access_tokens are long-lived, so acceptable).
3. [CLOSED 2026-07-08] coordinatorUrl IS REQUIRED even in local mode: Fixed — now warns when missing in local mode, only throws when spawnBackend==='coordinator'.
4. [WONTFIX: EXTERNAL TO PROJECT] GATEWAY IS A CLIENT, NOT A HOMESERVER. Fully self-hosting on a Pi also requires running a Matrix homeserver (Conduit/Dendrite/Synapse) — separate project, not provided here. Can point homeserverUrl at matrix.org to avoid this.
5. DM ROOM CREATION NOT IMPLEMENTED (resolveDmRoom returns null if no existing 2-member room, matrix.ts:236-264). Bot must be invited to DMs/rooms first.
6. [WONTFIX: EXTERNAL TO PROJECT] RESOURCE: local Ollama models on a Pi (no GPU) are slow; recommend OpenRouter or a small model.
7. [FIXED 2026-10-05, DRONE-GW-BUG-002] SYNC STORE CLOBBERED ROOM STATE. SqliteSyncStore.setSyncData did INSERT OR REPLACE of the LAST /sync response into saved_sync row id=1. A /sync response is a delta (first has rooms; later ones only add next_batch), so the persisted blob became a bare delta with a valid token but no `rooms`. On restart the client resumed an incremental sync, getRooms() was empty, and replies failed with "unknown conversation" — one-way chat after any restart (worse than no persistence, which would full-sync). Fixed by holding a SyncAccumulator: accumulate each response, persist the ACCUMULATED getJSON(true), and lazily rehydrate it (replay through accumulate(..., fromDatabase=true)) on first use; getSavedSync/getSavedSyncToken read the accumulator. Legacy clobbered rows are read best-effort so one full sync heals them. Guarded by a real-SDK start->sync->restart->sync regression test (test/sync-store-resume.test.ts) plus store-level tests.
   Recovery for a deployment already poisoned by the old store: `sqlite3 <dataPath> 'DELETE FROM saved_sync;'` then restart, so the client does ONE full sync (one-off step; no longer needed after the fix).
8. [FIXED 2026-10-05] CACHED-SYNC REPLAY RE-DISPATCHED HISTORICAL COMMANDS. Follow-on from #7. Once the store persists room history with a valid token, on every restart matrix-js-sdk replays the cached /sync (`syncFromCache` -> `processSyncResponse(fromCache:true)`) and re-emits each cached timeline event as `RoomEvent.Timeline`. `EventTimelineSet.addLiveEvent` ALWAYS emits with `toStartOfTimeline === false`; the only discriminator for replayed events is `data.liveEvent === false` (set false when `fromCache`). The adapter's handler filtered on `toStartOfTimeline` alone, so it re-dispatched old commands as fresh input: an earlier command's answer "answers" a later unrelated command (e.g. `swarm.session.list` got the `swarm.beacon.list` reply) and each restart re-fires the cached commands once, so replies duplicate (4x over 3 restarts). Fix: handler takes the full 5-arg signature `(event, room, toStartOfTimeline, removed, data)` and returns early on `removed || !data?.liveEvent` (the SDK's own documented check). Guarded by a real-SDK restart regression test (test/matrix-adapter-replay.test.ts). Lesson: with a persistent store, treat `RoomEvent.Timeline` as "timeline changed", not "new message" — gate on `data.liveEvent`.
