# ADR 006: Chat Tagging, Drain-on-Idle Batching, and Multi-User Response Opt-Out

**Status:** Accepted

**Context:** The gateway forwarded every inbound chat message to a spawned agent **unlabelled** and **one message at a time**. Three gaps followed.

1. **No speaker attribution.** The Matrix adapter already computed `senderName` and attached `senderId`/`senderName` to the `AdapterMessage`, but `persona-assignment` forwarded only `msg.text`, so the speaker was dropped on the floor. In a room (any group of 3+), all allowed senders share **one** agent session, so the agent saw an unlabelled stream and could not tell who said what. ADR 005's idle re-spawn made this worse: a re-spawned agent has no accumulated history from which to infer speakers.
2. **No batching.** A message that arrived while a turn was in flight was queued by the engine's `runOnTail`, so it became its **own full LLM turn**. A burst of N messages while busy cost N turns.
3. **No way to decline to answer.** In a multi-user room the bot answered every message. There was no way to tell the model "decide whether a reply is needed" and no way for it to stay silent.

**Also folded in (precondition):** the coordinator-mode send path was **dead**. `CoordinatorSpawnBackend.sendMessage` → `CoordinatorClient.sendMessage` posted `/api/messages/relay` with only `{toAgentId, body}`, but the route requires `fromBeaconId` and `fromAgentId` → a guaranteed **400 at the first hop**; and even past that, the relay lands the text in the agent's pull-only `pendingMessages` inbox, never as a user turn. The **send half** is fixed here so this feature is not local-only. The **receive half** (the gateway has no WebSocket client, and `sendSessionMessage` returns a delivery ack, not a reply) is deferred.

## Decision 1: Tagging lives in the surface, via a shared helper

**Decision:** A shared `chat-format.ts` helper owns the turn format. Tagging is applied by the **spawning surface** (`persona-assignment`), not the engine. The engine, `swarm-console`, and `discard` are untouched — `swarm-console` must still see raw `swarm.` lines.

**Rationale:** The `swarm-console` surface parses the raw line (`swarm.beacon.list`), so a globally-prefixed `msg.text` would break it. Tagging is only meaningful for surfaces that forward text to an LLM agent, so it belongs there.

## Decision 2: Bracketed tag, always on

**Decision:** Each inbound turn is tagged `[Alice] fix the build`. The name falls back `senderName → senderId → 'unknown'`. Applied in **rooms and DMs** (no toggle). Multi-line messages: only the first line is prefixed.

**Rationale:** Brackets do not collide with URLs (`http://…`) or timestamps and group visually. Always-on keeps DMs consistent with rooms at negligible cost.

## Decision 3: `conversationKind` on `AdapterMessage`

**Decision:** `AdapterMessage` gains a required `conversationKind: 'dm' | 'room'`. The Matrix adapter sets it from its `isDM` test (`joinedCount <= 2`). The gateway never inspects `conversationId`.

**Rationale:** `conversationId` is opaque to the gateway (`dm:<sender>` vs a room id is an adapter-private scheme). Only the adapter knows group-ness, so it must signal it explicitly. A named kind (not a bare `multiUser` boolean) is self-documenting and extensible.

## Decision 4: Drain-on-idle batching with a debounce

**Decision:** Every incoming message for a batch-eligible conversation is appended to that conversation's buffer, and the flush timer is (re)armed for `debounceMs`. When it fires, the buffer is drained and dispatched as **one** turn through `runOnTail` (so it waits behind any in-flight turn). One merged reply per batch. The buffered turns are joined by newline; each is already tagged, so the tags delimit.

**Rationale:** The engine's `runOnTail` is the single choke point that already serializes per conversation, so batching must live at or above it (a surface never sees the backlog). Drain-on-idle adds no latency to a lone message and coalesces a burst. The debounce catches bursty typing that would otherwise miss the batch window.

## Decision 5: Batching opt-in is structural; eligibility is exact + single-surface

**Decision:** A surface opts in by implementing an optional `DroneControlSurface.handleBatch(messages)`. Its **presence** is the opt-in (there is no disable flag). Batching is enabled only when a message resolves to an **exact** conversation, the sender is allowed, and that conversation has **exactly one** surface that defines `handleBatch`. Every other case (the wildcard, non-batch surfaces, multi-surface conversations) keeps today's immediate per-message path.

**Rationale:** `swarm-console` must keep immediate, per-command semantics (merging `swarm.beacon.list` + `swarm.session.list` is nonsense). The single-surface rule avoids encoding a command-vs-chat boundary in v1; mixed-surface batching is deferred (project memory `planning-seed-mixed-conversation-batching`).

## Decision 6: Debounce precedence and `0`-disables

**Decision:** The debounce is `config.batch.debounceMs` (surface) ?? top-level `batch.debounceMs` (config.json) ?? **500 ms**. `0` disables the debounce (flush on the next tick). The loader sanitizes it with the same rule as the idle timeout (finite, non-negative; warn-and-drop).

**Rationale:** Mirrors the ADR-005 `idleTimeoutMs` shape for consistency. Documented caveat: in a multi-surface conversation the surface-level `batch.debounceMs` is inert (batching is single-surface only).

## Decision 7: Silence is a sentinel owned by the gateway

**Decision:** The gateway exports `NO_RESPONSE_SENTINEL = '<<NO_RESPONSE>>'` and the room instruction that names it. The surface checks the reply with an **exact match modulo trim** (`reply.trim() === NO_RESPONSE_SENTINEL`) and, on a match, returns `{ response: null, handled: true }` so the engine posts nothing. The check is **unconditional** (rooms and DMs). A match is logged distinctly.

**Rationale:** An empty assistant reply is already overloaded in `drone-agent` as a _degenerate-response failure_ (retried with hints, then returned as `''`), and `LocalSpawnBackend` cannot distinguish "empty reply" from "no reply". A deliberate non-empty token avoids both ambiguities. The token and the instruction live in one process (the gateway) to avoid split-brain. Exact match (not `contains`) avoids swallowing a genuine reply that quotes the token.

## Decision 8: The room instruction rides a per-turn system reminder

**Decision:** The gateway-owned room instruction is attached **per turn** as an optional `systemReminder` on the turn payload (the local NDJSON `chat` event). The agent's listen host reads it and calls `_runtime.queueSystemReminder(...)`, which the conversation service already drains into the next LLM call as a **non-persisted** `role:'user'` `<system-reminder>`.

**Rationale:** A non-persisted reminder neither accumulates in history nor survives a re-spawn as stale text (it is simply re-sent next turn). Per-turn delivery avoids tracking session lifecycle and works identically once the coordinator transport carries the field. The agent gains a public `queueSystemReminder` on the engine beside the existing `drain`/`clear`.

## Decision 9: Coordinator send-half fix; the receive half is deferred

**Decision:** `CoordinatorSpawnBackend.sendMessage` delivers the turn via `CoordinatorClient.sendSessionMessage(processId, text, false)` — the path the coordinator UI uses — not the relay. Because there is no receive path, it returns **`null`** = "no synchronous reply"; the surface posts nothing for `null`. The now-dead relay client method is removed. `systemReminder` is **local-only** in this ADR.

**Rationale:** `sendSessionMessage` returns a delivery ack, not the assistant reply, so fixing only the send path would make the surface post the ack object as the chat reply. An explicit `null` makes the "cannot answer synchronously" outcome honest. The receive path (a gateway WS subscription to the coordinator `/ws`) is a separate subsystem and a separate plan.

## Consequences

- `AdapterMessage` gains required `conversationKind`; `DroneControlSurface` gains optional `handleBatch?`.
- `SpawnBackend.sendMessage` gains `opts?: SendMessageOptions` and returns `Promise<string | null>` (backends and test mocks swept).
- `GatewayConfig` gains `batch?: { debounceMs?: number }`; `SurfaceContext` gains `debounceMs?`.
- New modules: `drone-gateway/src/chat-format.ts`, `drone-gateway/src/batcher.ts`.
- `drone-agent` gains `InputEvent.systemReminder` and a public `engine.queueSystemReminder`.
- Deferred: the coordinator **receive path** (gateway WS subscription to `/ws`); `systemReminder` over the **coordinator** transport; **mixed-surface conversation batching** (seed `planning-seed-mixed-conversation-batching`); **per-sender session isolation**; a silence **tool** (`chat__stay_silent`).
