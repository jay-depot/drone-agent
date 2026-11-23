---
tags: [decision, coordinator, swarm-sessions, status-changed-at, migration]
related: [modules/drone-coordinator.md, 269-session-ended-at-duration.md]
---

# ADR 280: `swarm_sessions.status_changed_at` — a last-status-change stamp

**Status**: Implemented (2026-11-19, branch `feat/session-status-changed-at`)

## Context

Coordinator swarm session records carry a `status` value (`active`, `stale`,
`ended`, `processing`, `processed`, `archived`). The records carry no timestamp
for the last status change. A user cannot see how long a session has stayed in
one status.

The user runs external, user-provided processes. Those processes detect stuck
sessions and clean them up. Those processes need this timestamp. So the record
needs a field that holds the time when the status value last changed.

This is the sibling of ADR [269](269-session-ended-at-duration.md), which added
`ended_at` to the same table. The migration pattern, the required-nullable
type rule, and the "every row-rewriting UPDATE sets the new column" invariant
come from that work.

## Decision

**D1 — column name and type.** The database column is `status_changed_at`
(INTEGER). The TypeScript field is `statusChangedAt` (`number | null`).

**D2 — the field is REQUIRED and nullable.** `statusChangedAt` is
`number | null`, not `statusChangedAt?`. A required field makes the type
checker find every construction site. This is the ADR 269 rule. The `ended_at`
work found one missed site with this rule.

**D3 — migration.** The column is added by an idempotent PRAGMA-guarded
`ALTER TABLE` statement. The three existing swarm-session migrations
(`interactive`, `session_snapshot`, `ended_at`) and the new one moved out of
`initDatabase` into an exported function `migrateSwarmSessionColumns(db)` in
`drone-coordinator/src/db/init.ts`. That function is next to
`makeBeaconPortOptional`, which is the existing exported-and-unit-tested
precedent. There is no migration framework in this project.

**D4 — backfill inline, one time.** The backfill runs inside the same guard
that adds the column. The guard runs only when the column is new. So the
backfill runs exactly one time, on an existing database. A new database skips
the backfill, because the column already exists.

Backfill statement:
`UPDATE swarm_sessions SET status_changed_at = updatedAt WHERE status_changed_at IS NULL`

**This deliberately differs from ADR 269.** ADR 269 chose no backfill. An end
time is unrecoverable, so no end time is fabricated. A status-change time is
different: every status write also rewrites `updatedAt`, so `updatedAt` is a
recoverable proxy. The operator accepted `updatedAt` as the backfill source.

**D5 — stamp rule.** The stamp moves on every status change, and only when the
status value actually changes. A shared pure helper `nextStatusChangedAt`
compares the old value with the new value and returns `now` only on a real
change; otherwise it returns the previous stamp. A redundant status write must
not move the timestamp. If it moved, a long-stuck session would look recently
touched. That would defeat the stuck-detection use case.

The initial `active` value is the first status. So `createSwarmSession` stamps
the field with the creation time (`now`).

**D6 — `markStaleSessions` stamps the field.** The stale sweep changes the
status from `active` to `stale`. This is a real status change, so the sweep
stamps the field. This differs from `ended_at`, which deliberately does NOT
stamp on the stale sweep (`stale` is a liveness heuristic, not a stop).
`statusChangedAt` tracks the status value, so it stamps.

**D7 — `updateSwarmSessionPersona` carries the value forward.** This function
rewrites the row and does not change the status. It carries the old value
forward and sets the column explicitly in its `UPDATE` statement. This keeps
the ADR 269 invariant: every row-rewriting `UPDATE` sets the new column.

**D8 — surface sweep.** The field is added to:

- The full-row REST endpoints `GET /sessions` and `GET /sessions/:id`. The
  field flows through `rowToSwarmSession` automatically. Tests only.
- The hand-picked session subsets in `GET /sessions/:id/log` and
  `GET /sessions/:id/transcript`. Added explicitly — these subsets do not flow
  through automatically.
- The `drone-swarm` CLI session commands. The CLI passes JSON through, so the
  field flows through automatically. Tests only.
- The `/swarm-session list` slash command. This table is hand-rolled, so it
  gains a column.
- The `mcp-swarm` MCP tool `swarm.session.list`. The response schema is
  unconstrained, so the field flows through automatically. Test only.

**D9 — surfaces left unchanged.**

- The `drone-gateway` console output. The console human table is hand-picked,
  but the console `--json` output already carries the field. The operator
  chose to leave the console unchanged.
- The coordinator WebSocket initial-state dump. That dump is
  `beacon_sessions`-shaped and already omits `status`, `endedAt`, and
  `interactive`.
- The coordinator UI sessions page. The operator chose to leave the UI
  unchanged. The field is still available to external tools through the REST
  API.

## Consequences

Legacy rows get a `status_changed_at` equal to their `updatedAt` — a faithful
proxy, not a fabricated instant, because every status write rewrites
`updatedAt`. A legacy row that never had a status change keeps the stamp of its
last write. Tests cover the migration (add + backfill, idempotence, no backfill
on a fresh database), the stamp rule (real change moves it, redundant write
does not, create stamps, stale sweep stamps, persona update preserves), and the
API surface.
