---
tags: [decision, coordinator, coordinator-ui, swarm-sessions, duration]
related: [modules/drone-coordinator.md, modules/drone-coordinator-ui.md]
---

# ADR 269: `swarm_sessions.ended_at` + a true duration column

**Status**: Implemented (2026-11-02, branch `feat/ui-polish`)

## Context

The coordinator Sessions page has a "Duration" column that actually shows the
session's **age**. `formatDuration(connectedAt)` computed
`Date.now() - connectedAt`, because `swarm_sessions` records no end time at
all: the table has only `createdAt` / `updatedAt`, and `updatedAt` is rewritten
by every status transition, so it cannot serve as an end time. A session that
ended two days ago showed the same growing number as one running right now.

A separate table, `beacon_sessions`, does record `disconnected_at` +
`duration_ms`, but `GET /sessions` reads `swarm_sessions`, not that table.

## Decision

**D1 — nullable `ended_at INTEGER` on `swarm_sessions`.** Added by an
idempotent migration in `db/init.ts` (PRAGMA-guarded `ALTER TABLE`, alongside
the existing `interactive` / `session_snapshot` migrations). `SwarmSession`
gains `endedAt: number | null`, mapped through `rowToSwarmSession`, so the
value flows to the API for free (`GET /sessions` returns DB rows directly).

**D2 — the clock stops only when a session leaves a live status, set-once.**
Live statuses are `active` and `stale` (`stale` is the 24h inactivity
heuristic, not a stop — a stale session can still be processed and its true
end is not yet known). A transition FROM a live status INTO any non-live
status (`ended`, `processing`, `processed`, `archived`) stamps `ended_at` with
the transition time; the stamp is set-once — later bookkeeping transitions
(`processing → processed`, `processed → archived`, `archived → processed`
restore) carry the existing value forward and never overwrite it. Implemented
in both `updateSwarmSessionStatus` and `transitionSessionStatus` via a shared
`LIVE_STATUSES` / `freezesClock` helper. `markStaleSessions` is untouched (it
writes a live status).

**D3 — no backfill; show the truth.** Existing rows' true end times are
unrecoverable, so none are fabricated. The UI renders three branches: a set
end time → frozen `formatDuration(endedAt - createdAt)`; a live status with no
end time → `~`-prefixed age at render time (no live ticker); a non-live status
with no end time → the literal `unknown` — if a session should have a fixed
duration but we cannot calculate it, we say so.

**D4 — one shared formatter.** `drone-coordinator-ui/src/lib/duration.ts`
exports `formatDuration(ms)` (ladder `42s` / `17m` / `3h 05m` / `2d 04h`,
second unit zero-padded) and `formatSessionDuration({ createdAt, endedAt,
status }, now?)`. Both the Sessions page (via the wrapper) and the beacon
detail page (direct, replacing its inline minutes-only formatting) use it.
`endedAt` is NOT added to the UI `BeaconSession` type, and the WebSocket
`initial` snapshot (active-only, ignored by the Sessions page) is unchanged.

## Consequences

Legacy rows that are already non-live render `unknown` permanently — accepted,
per D3. An `active → processing` route (legal without passing `ended`) now
stamps `ended_at`, which is correct: processing starts after the agent's work
stopped. Tests cover the formatter ladder and three UI branches
(`duration.test.ts`, `sessions.test.tsx`), the stamp/set-once/legacy/no-stale
rules (`db.test.ts`), and the API surface (`routes/swarm.test.ts`).
