---
tags: [decision, gateway, matrix, adapter]
related: [modules/drone-gateway.md, decisions/058-gateway-config-model.md, decisions/235-gateway-architecture-standalone-service.md]
---

# 059: Matrix Service Adapter — matrix-js-sdk Bot Client, Folder Config, Discard Surface

**Status**: Implemented (2026-07-08)

## Context

The gateway needed its first chat platform integration. Matrix was chosen as the initial adapter because it's open-source, self-hostable, and supports both rooms and direct messages. The adapter needed to handle per-peer DM routing (different peers → different control surfaces), E2EE rooms, and rich message formatting.

## Decisions

### 1. matrix-js-sdk Bot Client (Option A)

The adapter uses `matrix-js-sdk` as a bot/user client authenticated by access token. The SDK handles the `/sync` loop, timeline events, and E2EE decryption natively via its crypto stack. Appservice (bridge mode) is deferred to Phase 5 as a moonshot.

### 2. Allowlist + DMs on by Default (Option B)

The adapter listens in all DMs automatically (rooms with ≤2 joined members). For non-DM rooms, an explicit `rooms[]` allowlist in config controls which rooms to process. This balances security (no unexpected room joins) with convenience (DMs just work).

### 3. DM Conversation IDs: `dm:@peer:server`

DMs use the format `dm:@peer:server` as the conversationId, enabling per-peer control surface assignment. Rooms use the raw room ID (e.g. `!abc:matrix.org`).

### 4. Markdown→HTML Replies (Option C)

Outgoing messages include both a plain `body` and an HTML `formatted_body` (via `org.matrix.custom.html` format). The `BasicMarkdownRenderer` handles code fences, inline code, bold, italic, links, and lists. It's behind a `MarkdownRenderer` interface so it can be swapped for `marked`/etc. later.

### 5. Read Receipts + Typing Notifications

The adapter sends read receipts for the last event in each conversation and typing notifications while the agent is processing. Both are best-effort (failures are caught and logged, not propagated).

### 6. Best-Effort E2EE

Crypto initialization is attempted in a try/catch. If it fails (e.g., native crypto module not available), the adapter degrades to unencrypted rooms with a warning log. This avoids a hard dependency on the Rust crypto SDK.

### 7. Graceful Stop — Never Delete dataPath

`stop()` calls `client.stopClient()` to flush the crypto/sync store and release file handles. It does NOT delete `dataPath` — the store must persist across restarts for E2EE decryption and fast resume. Deletion only happens via the explicit `cleanup` subcommand (after `client.logout()`).

### 8. Ambient Type Declarations for Internal SDK Modules

`matrix-js-sdk` v34 doesn't expose `IndexedDBStore` or `MemoryStore` through its public type declarations. A `matrix-store.d.ts` ambient declaration file provides minimal class signatures for the dynamic `import()` in `getStore()`, avoiding `@ts-expect-error` directives.

## Consequences

- **Positive**: First chat adapter is operational — Matrix rooms and DMs can route to swarm agents
- **Positive**: The config-model refactor (ADR 058) was delivered alongside, enabling per-peer routing
- **Positive**: The `discard` surface gives unmatched DMs an explicit sink
- **Positive**: 28 new gateway tests covering the adapter, markdown renderer, and config loader
- **Tradeoff**: E2EE is best-effort — rooms with encryption may not be decryptable if the native crypto module is unavailable
- **Tradeoff**: DM room creation is not implemented — the bot must already be invited to the DM
- **Tradeoff**: The `dataPath` store uses `IndexedDBStore` which requires a browser-like environment; falls back to `MemoryStore` (no persistence) in Node.js

## Related

- [drone-gateway](../../drone-gateway/) — The gateway package
- [058-gateway-config-model](058-gateway-config-model.md) — Config model refactor (delivered alongside)
- [235-gateway-architecture-standalone-service](235-gateway-architecture-standalone-service.md) — Original gateway architecture ADR
