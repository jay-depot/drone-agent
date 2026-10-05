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
