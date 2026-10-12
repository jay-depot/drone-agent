---
tags:
  [
    decision,
    drone-gateway,
    control-surface,
    surface-modes,
    persona-assignment,
    observer,
    passive,
    mentions,
    catch-up-loop,
    adr,
  ]
related:
  [
    decisions/249-gateway-portable-context-continuity-and-outbound-ledger.md,
    decisions/233-gateway-chat-tagging-batching-optout.md,
    decisions/232-gateway-surface-lifecycle-and-working-dir.md,
    decisions/238-gateway-per-surface-spawn-backend.md,
    decisions/223-gateway-swarm-console-control-surface.md,
    modules/drone-gateway.md,
  ]
---

# 250: Gateway surface modes (`active` | `passive` | `observer`)

**Status**: Implemented (2026-10-12) · **Branch**: `feat/gateway-surface-modes` · **Plan**: project-memory `plan-gateway-surface-modes`

**Summary**: The `persona-assignment` surface had exactly one behaviour: every inbound message became a turn and the reply was posted. Two wanted deployment shapes did not fit that shape — a **notetaker/observer** (watches a room, builds memory/wiki/todos, must never post) and a **passive assistant** (an observer that answers the instant it is `@`-mentioned, silent otherwise). This ADR adds a per-surface `config.mode` with three values, a surface-local catch-up loop, adapter-side mention detection, and a per-mode reply block.

| Mode               | Turns                                                                                 | Replies                           |
| ------------------ | ------------------------------------------------------------------------------------- | --------------------------------- |
| `active` (default) | one turn per message (today's behaviour)                                              | posts the reply                   |
| `passive`          | buffers messages; a turn runs on the catch-up timer **or** immediately on `@`-mention | posts **only** on a mention round |
| `observer`         | buffers messages; a turn runs on the catch-up timer                                   | **never** posts                   |

## Context

Plan A ([249](249-gateway-portable-context-continuity-and-outbound-ledger.md)) shipped the portable-context snapshot/restore and the outbound ledger; it is a hard dependency of Plan B. A long-lived, slow-cadence, sometimes-silent agent is only coherent because Plan A restores its rolling context across idle/death re-spawns and gateway restarts.

The gateway's Matrix adapter sees only **live** events (`data.liveEvent`, non-backlog); there is no room-history read. So an observer has no way to reconstruct what it missed except by keeping the messages itself while it is running.

## Decision

**D1 — Mode is a delivery-and-reply axis.** `active`: turn + reply per message. `passive`: buffer (no turn); flush on mention **or** timer; reply only on a mention round. `observer`: buffer; flush on timer only; never reply. `passive`/`observer` do **not** run a turn per message — an observer that ran a turn per message and discarded the reply would be a token furnace.

**D2 — A catch-up = flush the surface-side inbound buffer as one turn.** The buffer is **in-memory**, held on the surface. It survives an idle-timeout terminate (it is not part of `SessionLifecycle`) and does **not** survive a gateway restart (accepted). No adapter history read exists or is added; the live buffer _is_ the history.

**D3 — The periodic flush is a surface-local `setInterval`, `unref()`'d**, armed continuously from surface construction. An **empty buffer is a no-op** (no spawn, no turn). Cadence = `config.catchUp.intervalMs`; there is **no** scheduled _outbound_ work (the injection API covers that).

**D4 — `@`-mention detection lives in the adapter.** Only the adapter knows the bot's own identity (`config.userId`) and sees raw event content. New optional `AdapterMessage.mentionsBot?: boolean`, stamped from `content['m.mentions'].user_ids.includes(config.userId)`. **`m.mentions` only** in v1; a plain-text fallback is deferred (a missed mention degrades to the normal cadence, not to silence).

**D5 — The mention lift is kind-agnostic** — no `conversationKind === 'room'` guard (that guard is _more_ code). Consequence: a `passive` **DM** bot replies only if explicitly `@`-mentioned (rare; harmless). Documented.

**D6 — `handleBatch` stays defined in all modes.** `handleMessage` and `handleBatch` both funnel into one shared `ingest(messages)`. The engine's `MessageBatcher` eligibility rules are **unchanged** (its burst-coalescing lifetime is orthogonal to the catch-up buffer). A mention is detected with `messages.some(m => m.mentionsBot)`. A flush drains the buffer **atomically** (snapshot-and-clear) on the `SessionLifecycle` tail; arrivals during a flush land in the next window.

**D7 — Reply control is two layers.** (a) a per-turn instruction from `chat-format.ts` (`composeSystemReminder(mode, kind, mentioned)`); (b) a **hard, code-enforced** surface block — `observer` and ordinary `passive` catch-ups always return `{ response: null, handled: true }` (the turn's tool/memory side effects still happen). Discarding modes **log** `Error:`-shaped replies at `warn` and post nothing. Folded in: the `CANCEL_SENTINEL` (`'__CANCELLED__'`) is filtered at the reply-decision site.

**D8 — Config validation.** `config.mode ∈ "active" | "passive" | "observer"` (absent ⇒ `active`); `config.catchUp.intervalMs` (non-negative number; absent ⇒ 900000; `0` disables; inert in `active`). An **invalid `mode` value throws** (hard load error, mirroring `targetBeaconId` — a typo must not silently make a notetaker chatty). An invalid `catchUp.intervalMs` is **warned and dropped**. Defaults are applied **surface-side** (via the engine-resolved `SurfaceContext`). The `SurfaceMode` primitive is kept clean (`surfaces/mode.ts` leaf module) for reuse by swarm-managed agents.

**D9 — Plan A continuations are mode-agnostic.** The ledger drain, snapshot/restore, and idle timer run in every mode. With defaults, `idleTimeoutMs` (5 min) < `catchUp.intervalMs` (15 min), so **every** observer tick is a cold-spawn + restore — correct _because_ Plan A exists. The coupling is documented; the two knobs are **not** auto-coupled.

**D10 — A mention-bearing ingest always requests a flush.** Flushes serialize on the lifecycle tail, so a mention arriving during a flush produces an immediate follow-up turn. The periodic timer is **independent** — it fires on its own cadence and is **not** re-armed on activity.

## Alternatives considered

- **Reply filter vs delivery axis.** Rejected a pure reply filter (run a turn per message, sometimes discard): for a notetaker watching a busy room that is a token furnace. The delivery axis (buffer + flush) is what makes an observer economical.
- **Adapter history read vs surface buffer.** Rejected reading room history on catch-up: the Matrix adapter has no such read, and adding one duplicates the SDK's timeline store. The live, in-memory buffer is the history; a restart-accepted gap is acceptable.
- **Gateway-side vs adapter-side mention detection.** Rejected gateway-side: only the adapter holds `config.userId` and the raw event content, and mention detection is a platform concern (`m.mentions` today, other platforms later).
- **Persisted catch-up buffer.** Deferred: the buffer is in-memory for v1; persistence (surviving a gateway restart) is a follow-up, not needed for the observer to work.
- **`lifecycle.run(() => flush(false))` for the timer (the plan's sketch).** Rejected as written: `flush` → `runTurn` → `lifecycle.send` → `this.run(...)` nests two `SessionLifecycle` tails and **deadlocks** (the outer run awaits a `flush` whose `send` is queued behind the outer run). The timer calls `void flush(false)` directly; `lifecycle.send` already serializes on the tail.

## Consequences

- The gateway can host a notetaker (`observer`) and a mention-reachable passive assistant (`passive`) without a token furnace; `active` is byte-for-byte the current behaviour except the folded-in `CANCEL_SENTINEL` filter.
- `SurfaceContext` gained required `mode`/`catchUpIntervalMs`; every literal constructor was swept (the engine, and the `persona-assignment` / `session-lifecycle` / `swarm-console` / `surface-registry` test factories). The engine startup log describes each surface's placement **and** mode (`persona-assignment(local,observer)`) and logs the catch-up interval for non-active surfaces.
- **Deferred / follow-ups (record, do not build in Plan B):**
  - Emoji reactions (the `platformRef` seam already exists).
  - A `mention-router` (`!persona`) control surface.
  - Scheduled _outbound_ work (the injection API covers it).
  - A persisted catch-up buffer (survives a gateway restart).
  - The plain-text `@`-mention fallback (`@<localpart>` / display name).
  - A manual "flush now" trigger.
  - Coordinator-mode support (blocked on the coordinator receive path).
