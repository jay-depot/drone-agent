---
key: matrix-gateway-raspberry-pi-gaps
tags:
  - gateway
  - matrix
  - raspberry-pi
  - gap
  - setup
created: 2026-07-08T21:21:06.718Z
updated: 2026-07-08T21:21:06.718Z
---

How to stand up a Matrix chatbot on a Pi using drone-gateway (standalone/local spawn backend, no beacon/coordinator needed):

PIPELINE:
- drone-gateway (src/index.ts `serve`) loads ~/.drone-gateway/config.json + adapters/*/adapter.json + adapters/*/conversations/*.json (CONTEXT.md, config/load.ts).
- MatrixServiceAdapter (src/adapters/matrix.ts) connects via matrix-js-sdk. DM = rooms with <=2 members -> convId `dm:@peer:server`; rooms use roomId; allowlist via `rooms[]` (DMs always included).
- Per-conversation control surfaces: `persona-assignment` spawns `drone-agent --output-json --persona <id>` via LocalSpawnBackend (local-spawn-backend.ts) and returns the reply. `discard` = /dev/null (good for wildcard `_default_.json`).
- Replies: markdown->HTML (BasicMarkdownRenderer), read receipts, typing.

GAPS THAT CANNOT BE CLOSED WITH SHELL/SYSTEMD ALONE:
1. PERSISTENT E2EE STORE ON NODE: getStore() (matrix.ts:312-344) tries IndexedDBStore(dataPath) then falls back to in-memory MemoryStore. IndexedDBStore needs a browser IndexedDB global; on a headless Pi it will throw and silently fall back to MemoryStore. Result: megolm inbound keys don't persist, so after restart the bot can't decrypt messages sent while offline and may fail to decrypt in E2EE rooms on first sync. Workaround the code forces: use UNENCRYPTED rooms (adapter warns on crypto failure). A real Node-persistent store (leveldb/localStorage-backed) is missing from the code.
2. NO LOGIN/TOKEN FLOW: adapter.json requires a pre-made `accessToken` (matrix.ts:62-69). There is no login/registration/refresh in code. Partially scriptable: `curl -XPOST $homeserver/_matrix/client/v3/login` with password returns an access_token, but no refresh/rotation is implemented (password access_tokens are long-lived, so acceptable).
3. coordinatorUrl IS REQUIRED even in local mode (config/load.ts:57 throws if missing), though unused by LocalSpawnBackend. Must supply a dummy string.
4. GATEWAY IS A CLIENT, NOT A HOMESERVER. Fully self-hosting on a Pi also requires running a Matrix homeserver (Conduit/Dendrite/Synapse) — separate project, not provided here. Can point homeserverUrl at matrix.org to avoid this.
5. DM ROOM CREATION NOT IMPLEMENTED (resolveDmRoom returns null if no existing 2-member room, matrix.ts:236-264). Bot must be invited to DMs/rooms first.
6. RESOURCE: local Ollama models on a Pi (no GPU) are slow; recommend OpenRouter or a small model.