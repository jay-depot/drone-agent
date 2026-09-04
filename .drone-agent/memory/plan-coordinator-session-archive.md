---
key: plan-coordinator-session-archive
tags:
  - plan
  - coordinator
  - ui
  - sessions
  - archive
  - status-machine
  - swarm
created: 2026-09-04T04:07:00.715Z
updated: 2026-09-04T04:25:32.269Z
---

# Plan: Coordinator session archive + status-transition UI

## Feature summary

Add an `archived` terminal status to the swarm session pipeline plus the coordinator UI actions to reach it and return from it. Sessions end up `processed` after the memory pipeline; archiving hides them from the default sessions list (decluttering completed pipeline output) while keeping them restorable. The manual `POST /sessions/:id/end` route is formalized from permissive (any status) to a guarded state-machine transition, while the beacon's sync `DELETE /sessions/:id` (the authoritative agent-shutdown signal) stays permissive.

Confirmed state machine:
```
active ──(24h no activity)──→ stale
active/stale/processing/processed ──(manual /end)──→ ended   (guarded; NOT from archived)
ended ──(/process)──→ processing ──(/processed)──→ processed
processed ──(/archive)──→ archived                            (new terminal, exact reverse edge)
archived ──(/restore)──→ processed                            (new, lands on processed)
active ──(agent shutdown, beacon sync DELETE)──→ ended        (stays permissive, any status incl. archived)
```

## STATUS: COMPLETED AND VERIFIED ✅ 2026-09-04

This plan was fully executed on branch `feat/memory-wiki-browser-improvements`; all validation criteria passed. Per-step summary:

1. **drone-core**: `SESSION_STATUSES.ARCHIVED = 'archived'` added; `SessionStatus` union widened.
2. **Coordinator DB** (`db/swarm-sessions.ts`): `listSwarmSessions`/`countSwarmSessions` gained `exclude?: string`; `archiveSwarmSession`/`restoreSwarmSession` wrappers over `transitionSessionStatus`; both exported from `db/index.ts`.
3. **Coordinator routes** (`routes/swarm.ts`): `GET /sessions` accepts `exclude=`; `/sessions/:id/end` now guarded (`['active','stale','processing','processed'] → 'ended'`, 409 on others incl. archived); new `POST /sessions/:id/archive` (publishes `session.archived`) and `POST /sessions/:id/restore` (publishes `session.processed`).
4. **Beacon proxy**: `GET /sessions` forwards `exclude=`; `CoordinatorClient.getSessions` already passed through arbitrary keys.
5. **CLI** (`drone-swarm`): `session archive <id>` / `session restore <id>`; bare `session list` sets `exclude=archived` (unless `--status` given); HELP updated.
6. **UI** (`sessions.tsx`): URL-persisted `?view=archived` toggle (header button "Archived"/"Sessions"); default fetch `exclude=archived`, archived view `status=archived`; per-row End (stale/processing/processed), Archive (processed), Restore (archived); `archived`/`ended`/`stale` badges; dead `finished` references swept; archived-aware empty state.
7. **Tests**: coordinator DB (exclude/archive/restore), coordinator routes (guarded end incl. archived→409 + already-ended→409 change, archive/restore 200/404/409, exclude filter), beacon proxy exclude forwarding, CLI archive/restore + default-exclude (recording-fetch). New `drone-coordinator-ui/src/pages/sessions.test.tsx` added (typechecks; cannot RUN due to pre-existing react-dom 19.2.7/testing-library `React.act` infra break — documented in `pre-existing-integration-failures`).
8. **Docs**: `memory-pipeline.md` lifecycle + CLI + status section; `session-import.md` status list; `drone-coordinator/README.md` archive/restore routes.

### Behavior change (intentional, per plan / user sign-off)
- `POST /sessions/:id/end` on an `archived` session now returns 409 (was "any status → ended"). The beacon sync `DELETE` still ends archived sessions (permissive by design).

### Validation results
- LSP: zero errors/warnings introduced.
- `pnpm -r run build`: zero errors.
- `pnpm lint` (eslint + prettier): zero errors.
- `pnpm typecheck`: zero errors.
- `pnpm test` (fast suite): 2731 passed | 14 skipped.

## Out of scope (deferred)
- Batch archive (checkboxes / select-all) — deferred, per-row only.
- session-detail page status badge changes — cosmetic "● Live" left untouched.
- An "everything including archived" third view state — two-state toggle only.