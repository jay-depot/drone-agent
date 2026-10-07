---
tags: [decision, gateway, chat, tagging, batching, spawn-backend, protocol, architecture, adr]
related: [modules/drone-gateway.md, modules/drone-agent.md, concepts/spawn-backend.md, decisions/232-gateway-surface-lifecycle-and-working-dir.md, decisions/224-gateway-spawn-targeting.md, decisions/217-steer-and-btw-commands.md, concepts/json-listen-mode.md]
---

# 233 — Gateway chat tagging, drain-on-idle batching, and multi-user response opt-out

**Status**: Implemented (2026-10-05) · **Branch**: `feat/gateway-surface-lifecycle-and-workdir` · **Commit**: `b7c2af64` · **Gateway ADR**: merged into this page (2026-10-06) — the former in-tree `drone-gateway/docs/adr/006-chat-tagging-batching-optout.md` copy was deleted

**Summary**: The gateway forwarded every inbound chat message to a spawned agent **unlabelled** and **one message at a time**, and the bot in a multi-user room had no way to decline to answer. This ADR tags each turn with the speaker's name (rooms **and** DMs), coalesces a burst that arrives while a turn is in flight into **one** turn (drain-on-idle + debounce, via a new `MessageBatcher`), and gives the model a per-turn room instruction plus a `<<NO_RESPONSE>>` sentinel so it can stay silent. Folded in: the coordinator-mode **send path** was dead (a guaranteed 400 at the first hop) and is fixed; the **receive half** is deferred.

## Why

1. **No speaker attribution.** The Matrix adapter already computed `senderName` and attached `senderId`/`senderName` to the `AdapterMessage`, but `persona-assignment` forwarded only `msg.text`. In a room (any group of 3+) all allowed senders share **one** agent session, so the agent saw an unlabelled stream and could not tell who said what. ADR 232's idle re-spawn made it worse: a re-spawned agent has no accumulated history to infer speakers from.
2. **No batching.** A message that arrived while a turn was in flight was queued by the engine's `runOnTail`, so it became its **own full LLM turn**. A burst of N messages while busy cost N turns.
3. **No way to decline to answer.** In a multi-user room the bot answered every message.

## Locked decisions (9)

1. **Tagging lives in the surface, via a shared helper.** A new `chat-format.ts` owns the turn format; the **spawning surface** (`persona-assignment`) applies it. The engine, `swarm-console`, and `discard` are untouched — `swarm-console` must still see raw `swarm.` lines (a global prefix would break its parser).
2. **Bracketed tag, always on.** `[Alice] fix the build`; name falls back `senderName → senderId → 'unknown'`; applied in **rooms and DMs** (no toggle); only the first line prefixed. Brackets do not collide with URLs or timestamps.
3. **`conversationKind` on `AdapterMessage`.** A required `'dm' | 'room'`, set by the Matrix adapter from its `isDM` test (`joinedCount <= 2`). `conversationId` is opaque to the gateway (`dm:<sender>` vs a room id is an adapter-private scheme), so only the adapter can signal group-ness; a named kind beats a bare `multiUser` boolean.
4. **Drain-on-idle batching with a debounce.** Every incoming message for a batch-eligible conversation is appended to its buffer and the flush timer is (re)armed for `debounceMs`; on fire the buffer drains as **one** turn through `runOnTail`, so it waits behind an in-flight turn. One merged reply per batch; buffered turns joined by newline (each already tagged). The engine's tail is the single choke point, so batching must live at or above it — a surface never sees the backlog.
5. **Batching opt-in is structural; eligibility is exact + single-surface.** An optional `DroneControlSurface.handleBatch(messages)` — its **presence** is the opt-in (no disable flag). Batching is enabled only when a message resolves to an **exact** conversation, the sender is allowed, and the conversation has **exactly one** surface that defines `handleBatch`. Every other case (wildcard, non-batch surfaces, multi-surface conversations) keeps the immediate per-message path. (`swarm-console` must stay immediate per-command; the single-surface rule avoids a command-vs-chat boundary in v1.)
6. **Debounce precedence, `0`-disables.** `config.batch.debounceMs` (surface) ?? top-level `batch.debounceMs` ?? **500 ms**; `0` disables (flush next tick); loader sanitizes exactly like the idle timeout. Caveat: in a multi-surface conversation the surface debounce is inert (single-surface only).
7. **Silence is a gateway-owned sentinel.** `NO_RESPONSE_SENTINEL = '<<NO_RESPONSE>>'` plus the room instruction that names it live together in the gateway. The surface checks an **exact match modulo trim**; on a match it returns `{ response: null, handled: true }` so the engine posts nothing, and logs distinctly. Checked **unconditionally** (rooms and DMs). Rationale: an empty assistant reply is already overloaded in `drone-agent` as a *degenerate-response failure* (retried with hints, then returned as `''`), and `LocalSpawnBackend` cannot distinguish "empty reply" from "no reply"; a deliberate non-empty token avoids both. Exact match (not `contains`) avoids swallowing a genuine reply that quotes the token.
8. **The room instruction rides a per-turn system reminder.** Delivered **per turn** as an optional `systemReminder` on the turn payload (the local NDJSON `chat` event); the agent's listen host calls `_runtime.queueSystemReminder(...)`, drained into the next LLM call as a **non-persisted** `role:'user'` `<system-reminder>`. Non-persisted, so it neither accumulates nor survives a re-spawn as stale text.
9. **Coordinator send-half fix; receive half deferred.** `CoordinatorSpawnBackend.sendMessage` delivers via `CoordinatorClient.sendSessionMessage(processId, text, false)` (the path the coordinator UI uses), **not** the relay, and returns **`null`** = "no synchronous reply"; the surface posts nothing for `null`. The dead relay client method is removed. `systemReminder` is **local-only** here. Rationale: `sendSessionMessage` returns a delivery ack, not the assistant reply, so fixing only the send path would make the surface post the ack object as the chat reply.

## Implementation

- `drone-gateway/src/chat-format.ts` (**new**) — `formatChatTurn`, `NO_RESPONSE_SENTINEL`, `ROOM_INSTRUCTION`, `isNoResponse`.
- `drone-gateway/src/batcher.ts` (**new**) — `MessageBatcher` (`push`/`dispose`, debounce timer, `unref`'d).
- `drone-gateway/src/types.ts` — `AdapterMessage.conversationKind` (required); `DroneControlSurface.handleBatch?`; `GatewayConfig.batch?`.
- `drone-gateway/src/spawn-backend.ts` — `SendMessageOptions { systemReminder? }`; `sendMessage(session, message, opts?)` → `Promise<string | null>`.
- `drone-gateway/src/local-spawn-backend.ts` — includes `systemReminder` in the NDJSON chat event when present.
- `drone-gateway/src/coordinator-spawn-backend.ts` — delivers via `sendSessionMessage`, returns `null`.
- `drone-gateway/src/coordinator-client.ts` — the dead relay `sendMessage` removed.
- `drone-gateway/src/surfaces/lifecycle.ts` — `send(text, opts?)` → `string | null`; a `null` reply is **normal** (no death-retry; still arms the idle timer).
- `drone-gateway/src/surfaces/persona-assignment.ts` — one `sendTurn(messages)` used by `handleMessage` and `handleBatch`: tags each, joins by newline, room → `{ systemReminder: ROOM_INSTRUCTION }`, `null`/sentinel → `{ response: null, handled: true }`, else the reply.
- `drone-gateway/src/engine.ts` — `DEFAULT_DEBOUNCE_MS = 500`, `resolveDebounceMs`, `InstantiatedConversation.batcher?`; `start()` builds a batcher for an exact single-surface `handleBatch` conversation; `handleMessage` routes to it; `dispatchBatch` runs it on the tail; `surfaceContext` gains `debounceMs`; `stop()` disposes batchers before surfaces.
- `drone-gateway/src/config/load.ts` — `sanitizeIdleTimeoutMs` generalized to `sanitizeNonNegativeNumber(value, label, log)`; surface `config.batch.debounceMs` and top-level `batch.debounceMs` validated; `GatewayConfig.batch` populated.
- `drone-gateway/src/adapters/matrix.ts` — sets `conversationKind` at the emit site.
- `drone-agent/src/runtime/plugin-engine.ts` — public `queueSystemReminder` on `DronePluginEngine` (beside `drain`/`clear`).
- `drone-agent/src/interactive.ts` — `InputEvent` chat variant gains `systemReminder?`; `runJsonListenMode` queues it before the turn.
- Plus gateway `CONTEXT.md` (glossary: *Chat Tag*, *Message Batcher*, *Batch Debounce*, *No-Response Sentinel*, *Room Instruction*; amended *Control Surface*, *Persona Assignment*, *Adapter Message*; config layout) and gateway ADR 006.

## Validation

LSP clean; `pnpm -r run build` (8 packages) exit 0; `pnpm typecheck` exit 0; `pnpm run lint` exit 0; root `pnpm test` **3586 passed / 14 skipped / 262 files**. New suites: `chat-format.test.ts` (10), `batcher.test.ts` (5), `interactive-listen-reminder.test.ts` (3); `persona-assignment-surface.test.ts` rewritten (16). Updated: `config-load.test.ts` (30), `session-lifecycle.test.ts` (12), `coordinator-client.test.ts` (34), `coordinator-spawn-backend.test.ts` (12), `engine.test.ts` (22 — +4 batching cases; the "serialize two messages" test repointed to a multi-surface conversation because a single-surface `persona-assignment` conversation now coalesces), `matrix-adapter.test.ts`, `plugin-engine.test.ts` (43), and `helpers.ts` (mock engines gained `queueSystemReminder`). Behavioral acceptance documented in the session.

## Notes

- **The engine's `runOnTail` is the only place that can batch.** A surface's `handleMessage` for message B is not called until A's turn resolves, so a surface can never see the backlog.
- **Two `apply_diff` failure modes hit during execution** (recorded as insights): hunks over template-literal lines collapse, and a hunk can duplicate the file tail. Recovered by `head -n <last-good-line>` truncation; the build caught both while the LSP reported the files clean.

## Out of scope (explicitly deferred)

- The coordinator-mode **receive path** (a gateway WS subscription to the coordinator `/ws`) — separate plan.
- `systemReminder` over the **coordinator** transport (rides with the above).
- **Mixed-surface conversation batching** (`[swarm-console, persona-assignment]`) — seed `planning-seed-mixed-conversation-batching`.
- **Per-sender session isolation.**
- A silence **tool** (`chat__stay_silent`).

## Related

- [drone-gateway](../../drone-gateway/) — the gateway module page (config model, key files, types, surfaces, tests).
- [drone-agent](../../drone-agent/) — `InputEvent.systemReminder` + `engine.queueSystemReminder`.
- spawn-backend — the `sendMessage` widening (`opts`, nullable reply).
- [232-gateway-surface-lifecycle-and-working-dir](232-gateway-surface-lifecycle-and-working-dir.md) — the prior gateway slice (idle re-spawn made the missing tag worse).
- [224-gateway-spawn-targeting](224-gateway-spawn-targeting.md) — the sibling per-surface config pattern.
- [217-steer-and-btw-commands](217-steer-and-btw-commands.md) — the agent-side `/steer` buffer, the analogous "mid-round absorption" shape.
- json-listen-mode — the `chat` event the `systemReminder` rides.
