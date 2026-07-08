---
key: matrix-adapter-4.2-plan
tags:
  - roadmap
  - gateway
  - matrix
  - plan
  - 4.2
created: 2026-07-08T19:34:59.008Z
updated: 2026-07-08T20:41:44.117Z
---

# Plan: 4.2 Matrix Service Adapter + Gateway Config-Model Refactor

## Summary
Deliver a Matrix chat adapter for `drone-gateway` (4.2, "Not started"). The per-peer DM routing requirement (you→swarm console, friends→mention router, everyone else→PR persona or discard) forced a config-model refactor first: flat `config.json` → folder hierarchy with per-adapter wildcard. Two coupled deliverables.

## Locked Decisions
- Client: `matrix-js-sdk` bot/user client (access token). Appservice (bridge mode) DEFERRED to Phase 5 as moonshot.
- Scoping: allowlist `rooms[]` + DMs on by default.
- Config fields: `homeserverUrl`, `accessToken`, `userId` (required); `deviceId`, `rooms[]`, `dataPath` (optional).
- Conversation IDs: rooms → `roomId`; DMs → `dm:@peer:server` (per-peer).
- Wildcard: adapter-scoped, reserved file `adapters/<id>/conversations/_default_.json` → convId `"*"`.
- Storage: folder-based (A). Gateway `config.json` + `adapters/<id>/adapter.json` + `adapters/<id>/conversations/<conv>.json`. Filenames sanitized keys; canonical convId read FROM in-file field (lossless).
- Replies: plain `body` + markdown→HTML `formatted_body` (fallback plain) + read receipts + typing notifications.
- Markdown: hand-rolled `BasicMarkdownRenderer` behind `MarkdownRenderer` interface (swappable for marked/etc later).
- Per-conversation DEDICATED control-surface instances; control-surface spec = ordered array per conversation (preserves 4.5 composition).
- DISCARD control surface (added): built-in `type:"discard"` → always returns {response:null, handled:true}. Gives "everyone else → /dev/null" an explicit, observable sink (engine logs "dropped via discard surface"). Used in `_default_.json` for unmatched DMs so they don't hit the silent unhandled-drop path.

## Architecture Contract
- Adapter owns conversation routing (only thing that knows room vs DM vs wildcard).
- Control surface invoked ONLY for its own conversation; never re-checks msg.conversationId; reads text + optional senderId/senderName decorations.
- Engine dispatch: exact convId (ordered, first-match-wins) → else `"*"` wildcard → else drop (only for genuine misconfig; discard surfaces handle the intentional /dev/null case).

## Steps (agent: coder/tester/reviewer)
1. Reshape types: `ControlSurfaceSpec`, `ResolvedServiceAdapter { id, type, config, conversations: Map<convId, ControlSurfaceSpec[]> }`, `GatewayConfig.serviceAdapters: ResolvedServiceAdapter[]`, `MarkdownRenderer`/`RenderedMessage`.
2. `src/markdown.ts` BasicMarkdownRenderer (code fences, inline code, bold, italic, links, lists, paragraphs; fallback formattedBody=null).
3. `src/config/load.ts` + `src/config/files.ts` folder loader `loadGatewayConfig(configPath)`: walk adapters/ + conversations/, `_default_.json`→"*", lossless convId from in-file field.
4. `src/engine.ts` refactor: `controlSurfaces: Map<adapterId, Map<convId, DroneControlSurface[]>>`, per-conversation dedicated instances, exact-then-"*" dispatch. Add `case 'discard'` → `{response:null, handled:true}`. `createAdapter` wires "matrix". Remove convId re-check in persona-assignment. `index.ts` loadConfig delegates to loader.
5. `src/adapters/matrix.ts` MatrixServiceAdapter: sdk.createClient, best-effort initCrypto() try/catch (unencrypted-only fallback); pass `dataPath` StoreHandle for Rust crypto + file-backed sync store. RoomEvent.Timeline → dm:@peer or roomId, allowlist drop, auto-join invites, sendMessage with typing+read receipt+HTML, DM room resolve/create. GRACEFUL STOP: `stop()` calls `client.stopClient()` + closes store handles (flush crypto/sync store, release fds) — DO NOT delete dataPath. Add `matrix-js-sdk` dep.
6. Update tests: engine.test.ts change "matrix throws" assertion to `slack`; add wildcard + dedicated-instance + discard tests. index.test.ts use temp folder tree.
7. New tests: markdown.test.ts, config-load.test.ts, matrix-adapter.test.ts (vi.mock matrix-js-sdk: client creation w/ token, timeline→dm:@peer, allowlist drop, discard catches unknown DM, sendMessage HTML+receipt+typing, stop() closes store without deleting dataPath).
8. Docs: docs/adr/002-gateway-config-model.md (folder hierarchy, dedicated instances, adapter-owns-routing, wildcard, discard-built-in); update CONTEXT.md (Conversation, Wildcard Control Surface, Discard Control Surface, folder layout).
9. (Optional) `drone-gateway cleanup --adapter <id>`: confirmation-gated decommission — `client.logout()` (device de-register) then rm dataPath. Operator action only; NOT part of runtime.
10. Validation + update roadmap memory 4.2 → Complete.

## dataPath crypto-cleanup (clarification)
- dataPath holds sync store + Rust crypto store. MUST persist across restarts for E2EE decryption + resume. Cleanup = graceful close (flush + release handles) in stop(), NOT deletion.
- Deletion only on intentional decommission (after client.logout()). Optional `cleanup` subcommand covers orphan pruning.

## Validation Criteria
- LSP diagnostics clean on drone-gateway/.
- `pnpm -r typecheck` + drone-gateway `tsc -b` clean.
- `pnpm lint` passes.
- `pnpm test` passes incl new suites (target ≥~28 new gateway tests incl discard).
- `pnpm build` compiles all packages.
- Optional manual: real homeserver smoke (join, dm:@peer, HTML reply, wildcard discard).
- roadmap memory 4.2 flipped to Complete; Phase-5 appservice noted.

## Execution Summary (2026-07-08)
All 10 steps completed. 17 files changed (+3232/−3427) in initial commit (0bc3918), then 5 files changed (+370/−3) for cleanup subcommand (90a5bcd). 94 test files, 1346 tests pass. Typecheck clean. LSP clean. Roadmap updated: 4.2 → Complete.

_Last updated: 2026-07-08_