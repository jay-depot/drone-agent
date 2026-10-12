---
tags:
  [
    decision,
    drone-gateway,
    portable-context,
    continuity,
    ledger,
    control-surface,
    persona-assignment,
    adr,
  ]
related:
  [
    decisions/246-portable-context.md,
    decisions/232-gateway-surface-lifecycle-and-working-dir.md,
    decisions/233-gateway-chat-tagging-batching-optout.md,
    decisions/234-gateway-external-process-injection.md,
    decisions/238-gateway-per-surface-spawn-backend.md,
    modules/drone-gateway.md,
  ]
---

# 249: Gateway portable-context continuity + outbound ledger + message-id labels

**Status**: Implemented (2026-10-12) · **Branch**: `feat/gateway-portable-context-adoption` · **Plan**: project-memory `plan-gateway-portable-context-adoption`

**Summary**: The `persona-assignment` surface's persistent agent had **no continuity** — the `SessionLifecycle` idle timeout terminated it, death recovery re-spawned a **blank** agent, and a gateway restart lost everything. Separately, messages the gateway itself posted (via the external-process injection API, e.g. a cron "news brief") were dropped by the adapter's self-echo filter, so the agent had a hole in its own history. This ADR adopts the engine-seeded `portable-context` capability ([246](246-portable-context.md)) for **local spawn mode only**:

1. **Snapshot / restore** — after every completed round, export the agent's context and store it in the adapter's SQLite DB; restore it (`importContext`) whenever a fresh agent must start.
2. **Outbound history ledger** — record every injection-API post, persisted; deliver all undelivered entries inline at the start of the agent's next turn.
3. **Message-id labels** — stamp each chat turn with the platform message id: `[<message-id> from: <Name>]` header line, prep for a future reactions/reply feature.

## Context

The plan's origin is the planning session that wrote `plan-gateway-portable-context-adoption`; the durable design is captured here. `portable-context` already shipped as dead code ([246](246-portable-context.md)); its first consumer was the `checkpoint` plugin ([247](247-checkpoint-plugin.md)). The gateway is its first **host** consumer.

The gateway spawns one persistent agent per conversation in local mode (`LocalSpawnBackend` → `drone-agent --output-json`, NDJSON listen mode); the coordinator backend has **no receive path** (its `sendMessage` returns `null`), so context export/import cannot be supported there.

## Decision

**D1 — Snapshot cadence.** A snapshot is exported **after every completed round** (a "round" = one `sendUserMessage` call ending in `roundComplete`). Unconditional; no throttle knob. The payload byte size is logged at debug.

**D2 — Restore point.** `SessionLifecycle.ensureSession()`: spawn the child, then if a snapshot exists for the conversation, `importContext` it **before** the first round. Both happen inside the lifecycle tail, so `importContext` strictly precedes the first `sendUserMessage`.

**D3 — Snapshot storage.** A new SQLite table (`context_snapshots`) in the adapter's `dataPath` DB, one row per conversation, latest-wins overwrite.

**D4 — No `dataPath` ⇒ disabled.** An adapter without `dataPath` gets neither the snapshot store nor the ledger, with **one startup warning per affected adapter**. The agent still runs.

**D5 — Disclosure-free snapshots.** A snapshot **never contains** the continuation-disclosure turn. Enforced **capability-side** in `exportContext` (drone-agent) via the shared `CONTINUATION_DISCLOSURE_MARKER` in drone-core. This also fixes the `checkpoint` plugin's save→restore→save nesting bug.

**D6 — Ledger scope.** Injection-API posts only. Agent replies are already assistant turns in context.

**D7 — Ledger delivery.** Inline at the start of the next user turn (persisted with it ⇒ survives compaction). **Not** a new NDJSON event.

**D8 — Drain semantics.** Entries accumulate while the agent is idle/away; the next turn drains **all** pending entries; rows are deleted **only after** successful delivery.

**D9 — Ledger persistence.** Rows live in the same SQLite DB (`pending_outbound`), survive a gateway restart, and are deleted only after the agent's turn succeeds.

**D10 — Drain handle.** `SurfaceContext` gains a pending-outbound drain handle; the engine records injections in `injectMessage` after the adapter returns. The wildcard `*` is never an injection target (the loader already enforces this).

**D11 — `platformRef`.** `AdapterMessage` gains an adapter-stamped `platformRef` (Matrix `event.getId()`), echoed by surfaces; the seam a future reaction/reply feature targets.

**D12 — Label shape.** A **header line of its own**: `[<message-id> from: <Name>]` then the body on the following line(s). Sender id is omitted for now; the id is **inert** (no prompt instruction yet).

**D13 — `sendMessage` returns the ref.** `DroneServiceAdapter.sendMessage` returns `Promise<string | undefined>` (the platform ref of the posted message), so ledger entries carry their own id.

**D14 — Backend contract.** `SpawnBackend` gains `exportContext(session)` / `importContext(session, data)`. `LocalSpawnBackend` implements both. `CoordinatorSpawnBackend` throws a clear "unsupported".

**D15 — Persistent reader.** `LocalSpawnBackend` moves from a per-request `readline` to **one persistent stdout reader per session**, with a single in-flight request slot (safe: callers serialize per conversation via the lifecycle tail).

**D16 — Prune deferred.** Snapshot pruning on conversation drop / adapter cleanup is deferred (documented as a TODO).

## Alternatives considered

- **Per-turn vs post-round snapshot.** Rejected per-turn: a "round" is the unit the conversation machinery completes; per-turn exports would capture partial rounds and multiply payloads. Post-round is the natural boundary the requester named.
- **Disk JSON vs SQLite.** Rejected disk JSON: the adapter already owns a `dataPath` SQLite DB; a table gives latest-wins overwrite, transactional writes, and one lifecycle for the sync/crypto/state stores ([D3](244-wiki-agent-read-count.md) precedent: a new coordinator table).
- **Gateway-side vs capability-side disclosure strip.** Rejected gateway-side: the gateway sees an opaque `DronePortableContextExport` and should not know the reminder's text; stripping in `exportContext` also fixes the `checkpoint` plugin for free ([D5](247-checkpoint-plugin.md)).
- **New `appendContext` NDJSON event vs inline delivery.** Rejected for Plan A: promoting the ledger delivery to a role-correct "append turns without a round" primitive is a larger change; inline delivery (a preamble on the next user turn) is persisted with the turn and survives compaction with no new protocol surface ([D7](#decision)).
- **Coordinator-mode export/import.** Rejected: blocked on a coordinator receive path that does not exist; the backend throws a clear "unsupported" instead of silently degrading.

## Consequences

- One rolling context can run indefinitely for a local-mode `persona-assignment` conversation; compaction (summary-drop + aggressive threshold) is the intended counterweight to payload growth, and the debug byte-size log exists to watch it.
- A gateway restart, idle timeout, or death re-spawn restores the agent's context instead of starting blank.
- The agent sees its own injection-API posts in its next turn, closing the self-echo hole.
- `SpawnBackend` and `DroneServiceAdapter` gained required members; every implementer and test fake was swept (`LocalSpawnBackend`, `CoordinatorSpawnBackend`, all engine/surface test backends, the matrix-adapter fake).
- **Deferred / follow-ups (record, do not build in Plan A):**
  - **Plan B** — per-surface `mode: active | passive | observer`, catch-up loops, `@`-mention triggers, per-mode reply blocking.
  - **Snapshot prune** — delete the `context_snapshots` row when a conversation is dropped from config or `cleanup` deletes the adapter (derived state). Add once Plan A is stable.
  - **`appendContext` NDJSON event** — promote the ledger delivery to a role-correct "append turns without a round" primitive; then ledger entries become real assistant turns.
  - **Model-facing message-id instruction** — teach the `[<id> from: X]` format together with the reaction directive when the reactions feature lands.
  - **Coordinator-mode context export/import** — blocked on the coordinator receive path.
  - **`formatChatTurn` sender id** — omitted for now; the adapter owns `m.mentions` matching later.
- **Risk: D15 reader refactor** flipped error semantics (reject vs resolve-an-error-string) and the early-exit path; every existing `local-spawn-backend` test was re-pointed deliberately.
