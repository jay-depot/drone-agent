---
tags: [decision, coordinator, drone-core, drone-coordinator-ui, drone-beacon, drone-swarm, sessions, archive]
related: [modules/drone-coordinator.md, modules/drone-coordinator-ui.md, modules/drone-core.md, modules/drone-beacon.md, modules/drone-swarm.md, concepts/session-processing-pipeline.md, decisions/093-session-status-mismatch-fix.md, decisions/031-session-processing-pipeline.md]
---

# 190: Coordinator session archive + guarded transition UI

**Status**: Implemented (2026-09-04, branch `feat/memory-wiki-browser-improvements`, commits `aee56bd` + `aab56e1`)

## Context

The coordinator session-processing pipeline
(session-processing-pipeline,
[031-session-processing-pipeline](031-session-processing-pipeline.md),
[093-session-status-mismatch-fix](093-session-status-mismatch-fix.md)) routes sessions
`active → stale → ended → processing → processed`. Once a session reaches
`processed` it had effectively nowhere to go: it sat in the default sessions
list forever, cluttering the UI and any `drone-swarm session list` output that
consumed it. The user wanted to be able to (1) add the missing "→ ended"
transitions (`stale`/`processing`/`processed` → `ended`) to the UI, and (2)
introduce an `archived` terminal status — hidden from the sessions list by
default, with a toggle to view archived sessions only and a per-row restore
back to `processed`.

This also surfaced a latent gap: the manual `POST /sessions/:id/end` route was
**permissive** (it transitioned *any* status to `ended` via the raw
`updateSwarmSessionStatus`, with a `// Allow ending from any status` comment).
Tracing history (ADR 093's original insight) revealed this was never a
deliberate "any status may end" decision — it was a by-product of the status
system having no central state machine: each route decided transitions
independently (`/process` guarded, `/processed` guarded, `/end` unguarded).

## Decision

Introduce an `archived` terminal status and formalize the manual `/end` route
into the same guarded `transitionSessionStatus` machinery used by the rest of
the pipeline. The beacon-facing sync `DELETE /sync/sessions/:id` (the
authoritative agent-shutdown signal) stays permissive.

**New/extended state machine:**
```
active ──(24h no activity)──→ stale
active/stale/processing/processed ──(manual /end)──→ ended   (guarded; NOT from archived)
ended ──(/process)──→ processing ──(/processed)──→ processed
processed ──(/archive)──→ archived                            (new terminal, exact reverse edge)
archived ──(/restore)──→ processed                            (new, lands on processed)
active ──(agent shutdown, beacon sync DELETE)──→ ended        (stays permissive, any status incl. archived)
```

1. **Status type** (`drone-core/src/session-types.ts`). `SESSION_STATUSES` gains
   `ARCHIVED: 'archived'`; the `SessionStatus` union widens automatically.
   `archived` is terminal — it never enters the `process` pipeline.

2. **Coordinator DB** (`drone-coordinator/src/db/swarm-sessions.ts`).
   - `listSwarmSessions`/`countSwarmSessions` gain an `exclude?: string`
     option (`AND status != ?`), so archived sessions can be filtered out of
     the default list while pagination stays honest.
   - New thin wrappers over the existing `transitionSessionStatus`:
     `archiveSwarmSession(id)` (`processed → archived`) and
     `restoreSwarmSession(id)` (`archived → processed`). Both return
     `SwarmSession | { error }` and are exported from `db/index.ts`.

3. **Coordinator routes** (`drone-coordinator/src/routes/swarm.ts`).
   - `GET /sessions` accepts `exclude?: string`, passed to both `list` and
     `count` (composes as SQL AND with an existing `status=`, though the two
     UI/CLI views never set both).
   - `POST /sessions/:id/end` switches from the permissive
     `updateSwarmSessionStatus(id, 'ended')` to a guarded
     `transitionSessionStatus(id, ['active','stale','processing','processed'], 'ended')`.
     404 on missing, 409 on a disallowed from-status (including `archived` and
     the previously-idempotent already-`ended` case). This is a deliberate
     behavior change: the manual end route no longer ends an `archived` or
     already-`ended` session.
   - New `POST /sessions/:id/archive` → `archiveSwarmSession` (404/409 pattern),
     publishes `session.archived`; new `POST /sessions/:id/restore` →
     `restoreSwarmSession`, publishes `session.processed` (the result status —
     no new `session.restored` event type).

4. **Beacon proxy** (`drone-beacon/src/routes/sessions.ts`). `GET /sessions`
   forwards an `exclude=` query param (alongside `status`/`limit`).
   `CoordinatorClient.getSessions` already forwards arbitrary keys, so no
   signature change.

5. **CLI** (`drone-swarm`). `session archive <id>` → `archiveSession(id)` and
   `session restore <id>` → `restoreSession(id)` (new `SwarmClient` methods,
   coordinator dialect). Bare `session list` (no `--status`) now sets
   `query.exclude = 'archived'`, so archived sessions are hidden by default —
   matching the UI and making automation/cron-based archival compose cleanly.
   `--status archived` lists archived sessions. HELP text updated.

6. **Coordinator UI** (`drone-coordinator-ui/src/pages/sessions.tsx`). A
   header toggle switches between the default view (`exclude=archived`) and the
   archived view (`status=archived`), persisted in the URL via `?view=archived`
   (mirroring the existing `offset` pagination param; reset pagination to 0 on
   switch). Per-row action buttons: `processed` rows get **Archive** (+ End),
   `archived` rows get **Restore**, `stale`/`processing` rows get **End**, and
   the dead `finished` reference in the Process-button condition was swept to
   `ended`. `getStatusBadge` gains `archived`/`ended`/`stale` cases. An
   archived-aware empty state. No batch archive (deferred).

7. **Behavior change noted for consumers**: `POST /sessions/:id/end` on an
   `archived` (or already-`ended`) session now returns 409. The beacon's sync
   `DELETE /sync/sessions/:id` still ends a session from any status, including
   archived — it remains the authoritative end-of-life signal.

## Tests

- **`drone-coordinator/test/db.test.ts`** — `listSwarmSessions({exclude})`
  omits the status, `countSwarmSessions({exclude})`; `archiveSwarmSession` from
  `processed` → `archived` and rejects non-`processed`; `restoreSwarmSession`
  from `archived` → `processed` and rejects non-`archived`.
- **`drone-coordinator/test/routes/swarm.test.ts`** — guarded `/end`
  (stale/processing/processed → ended; **already-ended → 409 behavior-change
  migration** of the prior idempotency test; archived → 409); `/archive` and
  `/restore` 200/404/409; `GET /sessions?exclude=archived` excludes from
  `sessions` and `count`. 50 tests total.
- **`drone-beacon/test/sessions.test.ts`** — `GET /sessions?exclude=archived`
  forwards `exclude` to the coordinator client.
- **`drone-swarm/test/cli.test.ts`** — fixture routes for
  `/api/sessions/s-1/archive` + `/restore`; `session archive`/`restore`;
  bare `session list` sends `exclude=archived` (via a recording fetch), and
  `--status archived` does not.
- **`drone-coordinator-ui/src/pages/sessions.test.tsx`** (new) — default view
  requests `exclude=archived`; toggling requests `status=archived` + renders
  Restore; processed rows render Archive + End. Typechecks and runs via the
  package's `pnpm test` (see ADR note below re: `NODE_ENV=test`).

Root `pnpm test` 2731 passed / 14 skipped; coordinator-ui suite 52 passed
(12 files); typecheck, build, and lint clean; LSP clean on all touched files.

## Notes

**En-route finding — the `React.act` UI-test "failure" was a run-environment
artifact.** Running bare `vitest run` in `drone-coordinator-ui` made every
`@testing-library/react` render throw `React.act is not a function`. Root
cause: react 19.2.7 exports `.act` only on its **development** build (selected
by `NODE_ENV`); bare vitest leaves `NODE_ENV` unset so react loads the
production build (no `act`). Running via the package's `pnpm test` script
(`NODE_ENV=test vitest run`) makes the whole 52-test suite pass. The only real
bug was in the new `sessions.test.tsx`, which used `.find()` on the mock fetch
calls (grabbing the *first* `exclude=archived` fetch) instead of the *latest*
`status=archived` fetch after toggling; fixed with a `lastSessionsCall()`
helper (`.filter().at(-1)`). This is documented in project memory
(`pre-existing-integration-failures`) — the suite was never actually broken.

## Alternatives considered

- **Keep `/end` permissive** — rejected: with `archived` as a true terminal
  sink, an unguarded manual end could reach into it, and the state machine
  would stay non-self-documenting. The guarded route plus the still-permissive
  beacon sync DELETE cleanly separates "operator wants to force-end a live
  session" from "the agent's session is really over".
- **Archive from `ended` (not `processed`)** — rejected: the user's mental
  model is that archival happens on already-`processed` (post-pipeline)
  sessions, giving the clean reversible pair `processed ⇄ archived`.
- **Batch archive (checkboxes)** — deferred: per-row only, consistent with the
  page's existing single-row actions; batch can come later if volume demands.
- **Client-side archived filtering** — rejected: breaks the existing
  server-side `limit`/`offset`/`count` pagination (archived rows would consume
  page slots and skew the count). Server-side `exclude=` keeps pagination
  honest in both views.

## Consequences

- The session pipeline now has a true terminal `archived` status that hides
  processed sessions from the default list (UI `exclude=archived` and CLI bare
  `session list` both exclude), with a restorable `processed ⇄ archived` pair.
- The manual `/end` route is a guarded state-machine transition; `archived` and
  already-`ended` sessions 409 on it. Existing scripts relying on manual-end
  idempotency or on updating an archived session via `/end` must switch to
  `/restore` or the beacon sync DELETE.
- `drone-swarm session list` (no `--status`) no longer returns archived
  sessions — a deliberate user-visible CLI behavior change (signed off) that
  makes automation/cron archival compose cleanly.
- New WS events `session.archived` (archive) and reuse of `session.processed`
  (restore) keep the UI live-updating.
- The old `finished` status reference lingering in the UI was swept to
  `ended`, completing the ADR 093 consolidation.
