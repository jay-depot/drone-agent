---
tags:
  [
    decision,
    drone-gateway,
    swarm-extension,
    scheduling,
    reminders,
    persona-assignment,
  ]
related:
  [
    modules/drone-gateway.md,
    254-swarm-extensions.md,
    256-gateway-swarm-extension.md,
  ]
---

# ADR 270: Gateway agent self-scheduling wake-ups

**Status**: Implemented (2026-11-08, branch `feat/gateway-swarm-extensions`)

## Context

ADR [256](256-gateway-swarm-extension.md) made drone-gateway a swarm extension
node, but declared an **empty capability manifest**. The gateway was a
**sender** only. The _callee_ direction — a gateway that declares callable
capabilities and answers invocations — was explicitly deferred.

This ADR delivers the callee direction and its first consumer: a
persona-assignment agent can schedule a one-time "wake-up" for itself. A
wake-up starts a new turn of the same agent at or just after a requested time,
and posts the agent's reply to the conversation. This makes a "general
assistant" handle sentences like _"Remind me to check the soup at 10
tomorrow"_.

The gateway is the correct place for this. It owns the agent process in local
spawn mode, the chat adapter, and the durable store.

## Decision

**D1 — a wake-up is a synthetic agent turn.** The gateway calls
`SessionLifecycle.send(wakePrompt)`. The reply is posted. v1 supports **local
spawn mode only**: only the local NDJSON `chat` frame returns a reply; the
coordinator's `deliverUserMessage` path returns none.

**D2 — a wake round is a deliverable round.** A wake round **lifts** the reply
block in `passive` and `observer` modes, so that one reply is posted in every
mode. The sentinels (`<<NO_RESPONSE>>`, `__CANCELLED__`) still suppress the
post.

**D3 — the feature is opt-in per surface.** Config key
`controlSurfaces[].config.schedule.enabled`, a boolean, default off. The loader
sanitizes the bag: a non-object `schedule` is warned about and dropped; a
non-boolean `enabled` is warned about and dropped.

**D4 — the `schedule_wakeup` tool takes `note` (required) and one of `dueAt`
(an ISO-8601 time with an offset) or `delayMs` (a relative delay in
milliseconds).** `dueAt` wins when both are present. The result echoes the
resolved instant and a relative form.

**D5 — pending wake-ups live in the adapter's SQLite `dataPath` database**
(new table `scheduled_wakeups`). When the adapter has no `dataPath`, the
feature is disabled and the gateway logs one warning. On restart, overdue
wake-ups fire immediately, oldest first. A wake-up on an idle session respawns
the agent and restores the snapshot. The session-to-conversation map is built
from the `sessionStarted` / `sessionEnded` events, by stripping the
`<extId>:` prefix from the extension hint.

**D6 — "triggered" means `SessionLifecycle.send()` resolved.** The row is
deleted then. The reply content controls **delivery only** (`posted`,
`sentinel`, `empty`), never trigger success. A _thrown_ send is a non-trigger:
the row stays, `attempts` increases, the gateway retries on the next tick, and
drops the row after 3 attempts with an error log.

**D7 — three capabilities, all `exposed: 'mcp'`, names without dots:**
`schedule_wakeup`, `schedule_list`, `schedule_cancel`. They materialize as the
agent tools `extensions__drone-gateway__schedule_*`, left **unmounted** (the
model mounts them with `runtime__mount_tool`). The gateway injects one guidance
fragment (`# Scheduled Wake-ups`). Each call is scoped by the invoke context's
`sessionId`.

**D8 — a surface-owned polled tick fires wake-ups.** The interval is the module
constant `DEFAULT_WAKEUP_TICK_MS = 15000`. It is not configurable in v1. The
engine adds a `postMessage(conversationId, text)` seam to `SurfaceContext` so a
fired wake can post its reply.

**D9 — the extension hint stays `<extId>:<conversationId>`** (ADR [256](256-gateway-swarm-extension.md) D3).
The gateway resolves the adapter by scanning which adapter declares that
conversation. On a collision (two adapters declare it), the gateway logs a
warning and returns a tool error.

**D10 — before the FIRST `sendMessage` only, the surface waits (bounded) until
the gateway's session registry knows the conversation's session.** The wait is
bounded (about 5 s) and polls every 250 ms. On timeout the surface continues
and logs a degradation. This closes the turn-1 tool-availability race.

## Non-goals (v1)

- **Coordinator spawn mode.** The gateway cannot see the reply in that mode.
- Recurring schedules (one-time only).
- Per-wake-up timezone (absolute instants only).
- The wildcard conversation `*`.
- A requirement that the model must produce text.
- Any configurable tick interval.

## Consequences

- **The turn-1 race is bounded, not eliminated.** The tools arrive through many
  hops. D10 covers it with a wait. If the wait is not enough, the model
  schedules from turn 2.
- **The spawned agent must run the `swarm` and `extensions` plugins**, and the
  gateway must reach a beacon. Without them no tools are injected and no
  invocation reaches the gateway.
- **Coordinator spawn mode is unsupported in v1.** A schedule tool called from
  such a session cannot post its reply; the schema and docs state the limit.
- **No new time plumbing.** The `startup` plugin already renders `# Current
Time` on every LLM call, re-rendered each call, so the model always knows the
  current time.
- New module constant file `drone-gateway/src/schedule/constants.ts`; new
  domain modules `catalog.ts`, `wake-prompt.ts`, `invoke.ts`, `service.ts`.
