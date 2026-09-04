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
updated: 2026-09-04T04:07:00.715Z
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

## Out of scope (deferred)
- Batch archive (checkboxes / select-all) — deferred, per-row only now.
- session-detail page status badge changes — the "● Live" badge there is cosmetic; not touching it.
- An "everything including archived" third view state — two-state toggle only.

## Architecture map (as found)

- Status source of truth: `drone-core/src/session-types.ts` (`SESSION_STATUSES`, `SessionStatus`).
- Coordinator DB: `drone-coordinator/src/db/swarm-sessions.ts` (list/count/update/transition + markStale). `listSwarmSessions({ status })` and `countSwarmSessions({ status })` only support single `status=` filtering.
- Coordinator routes: `drone-coordinator/src/routes/swarm.ts`. `/process` (guarded `['active','stale','ended'] → processing`), `/processed` (guarded `processing → processed`), `/end` (permissive `updateSwarmSessionStatus(id,'ended')`), `GET /sessions` (list+count, single `status=`).
- Beacon proxy: `drone-beacon/src/routes/sessions.ts` `GET /sessions` forwards `limit`/`status`; `drone-beacon/src/coordinator-client.ts` `CoordinatorClient.getSessions(query)` forwards to `/api/sessions`.
- CLI: `drone-swarm/src/client.ts` (`listSessions`, `processSession`, `markSessionProcessed`) + `drone-swarm/src/index.ts` (`runSessionCommand`).
- UI: `drone-coordinator-ui/src/pages/sessions.tsx` (default `exclude` fetch, toggle + URL `?view=` persistence via `usePaginationOffset`-style `useSearchParams`, per-row buttons, `getStatusBadge`); `drone-coordinator-ui/src/lib/types.ts` (`SwarmSession.status: string`).
- Tests: `drone-coordinator/test/db.test.ts`, `drone-coordinator/test/routes/swarm.test.ts`, `drone-beacon/test/sessions.test.ts`, `drone-swarm/test/cli.test.ts` (fixture server), UI has no `sessions.test.tsx` yet.
- Docs: `docs/agents/memory-pipeline.md` (lifecycle line + Status lifecycle section), `docs/agents/session-import.md` (status list), `drone-coordinator/README.md` (routes).

## Steps (atomic, ordered, dependencies noted)

### Step 1 — Add `ARCHIVED` to drone-core status types
- File: `drone-core/src/session-types.ts`
- Add `ARCHIVED: 'archived',` to `SESSION_STATUSES` (after `PROCESSED`).
- `SessionStatus` union picks it up automatically.
- **Deps:** none. **Validated:** `pnpm -r run build` (drone-core dist is the dependency source for downstream typecheck).

### Step 2 — Coordinator DB: guarded manual end + archive/restore transitions + exclude filter
- File: `drone-coordinator/src/db/swarm-sessions.ts`
- `listSwarmSessions({ status? })` → add `exclude?: string` option. When set, append ` AND status != ?` with `exclude`. Apply to the raft of query-building (list + count).
- Update `countSwarmSessions({ status? })` the same way.
- Add `archiveSwarmSession(id)` / `restoreSwarmSession(id)` thin wrappers over `transitionSessionStatus`:
  - archive: `transitionSessionStatus(id, 'processed', 'archived')`
  - restore: `transitionSessionStatus(id, 'archived', 'processed')`
- (No new DB fn needed for guarded end — `/end` route switches from `updateSwarmSessionStatus(id,'ended')` to `transitionSessionStatus(id, ['active','stale','processing','processed'], 'ended')`.)
- Export the two new fns from `drone-coordinator/src/db/index.ts`.
- **Deps:** Step 1 (uses `'archived'` string literal, matches `SESSION_STATUSES`). **Validated:** coordinator unit tests.

### Step 3 — Coordinator routes
- File: `drone-coordinator/src/routes/swarm.ts`
- `GET /sessions`: accept `exclude?: string` in `Querystring`; pass to both `listSwarmSessions` and `countSwarmSessions`.
- `/sessions/:id/end`: replace `updateSwarmSessionStatus(id,'ended')` with `transitionSessionStatus(id, ['active','stale','processing','processed'], 'ended')`. Keep 404 for not-found, map `{error}` → 409. (Preserve the existing "end from any pre-terminal status" tests; now archived → 409.)
- Add `POST /sessions/:id/archive`: `archiveSwarmSession(id)`; 404 if not found, 409 for wrong from-status (i.e. only `processed`). On success `publishMutationEvent({ sessionId, eventType: 'session.archived', payload: { sessionId, status: 'archived' } })`; return `{ session: result }`.
- Add `POST /sessions/:id/restore`: `restoreSwarmSession(id)`; 404/409 same pattern; on success `publishMutationEvent({ sessionId, eventType: 'session.processed', payload: { sessionId, status: 'processed' } })`; return `{ session: result }`.
- **Deps:** Step 2. **Validated:** route tests.

### Step 4 — Beacon proxy passthrough
- File: `drone-beacon/src/routes/sessions.ts` — `GET /sessions` Querystring: add `exclude?: string`; forward `request.query.exclude` into the `query` object passed to `client.getSessions(query)`.
- File: `drone-beacon/src/coordinator-client.ts` — `getSessions(query: Record<string, string>)` already forwards arbitrary keys; no signature change needed. (Verify no typed whitelist.)
- **Deps:** Step 3 (coordinator accepts `exclude`). **Validated:** beacon proxy test.

### Step 5 — CLI: archive/restore subcommands + default exclude
- File: `drone-swarm/src/client.ts` — add `archiveSession(id)` / `restoreSession(id)` posting to `/sessions/:id/archive` and `/sessions/:id/restore` (coordinator dialect). Mirror `processSession`/`markSessionProcessed` error handling.
- File: `drone-swarm/src/index.ts`:
  - `session archive <id>` → `client.archiveSession(id)`
  - `session restore <id>` → `client.restoreSession(id)`
  - `session list`: when no `--status` flag is given, set `query.exclude = 'archived'` (so bare `session list` hides archived; `--status archived` still shows them).
  - Update `HELP` text: add `session archive <id>` / `session restore <id>`; note `session list` excludes archived by default.
- **Deps:** Step 3 (routes). **Validated:** CLI fixture tests.

### Step 6 — Coordinator UI: archive/restore/end controls + archived view toggle
- File: `drone-coordinator-ui/src/pages/sessions.tsx` (and `src/lib/types.ts` if needed).
- Add a view-state: `const [view, setView] = useState<'normal'|'archived'>(...)` persisted in the URL via `useSearchParams` (`?view=archived`); default `'normal'`. (Reuse the `usePaginationOffset`-style URL persistence pattern; keep `offset` independent.)
- `fetchSessions`: build the URL — normal view → `exclude=archived`; archived view → `status=archived`. Reset `offset` to 0 when switching views.
- Header: add a compact toggle button next to the live badge — "Archived" / "Sessions" label reflecting the active view; clicking flips `?view=` between absent and `archived`.
- Table actions:
  - `stale`/`processing`/`processed` rows get an **End** `POST /api/sessions/:id/end` (no beacon DELETE — manual end), reusing the existing confirm-dialog pattern (extend `dialogAction` union with `'end'`).
  - `archived` rows get **Restore** `POST /api/sessions/:id/restore`.
  - `processed` rows get **Archive** `POST /api/sessions/:id/archive`.
  - Keep existing Terminate/Process/Mark Processed/Peek.
- `getStatusBadge`: add `archived` case (e.g. `variant="ghost"` or a muted style) and `ended`/`stale` cases so they no longer fall through to the raw-value default.
- Empty-state copy: when in archived view and empty, say "No archived sessions" + the normal empty text otherwise.
- **Deps:** Steps 1–3 (status + routes). **Validated:** UI tests + build.

### Step 7 — Tests (unit-level, per layer)
- `drone-core`: no test needed (pure type + const) unless a status-list test exists — check `test/index.test.ts`; if it asserts the statuses, add `archived`.
- `drone-coordinator/test/db.test.ts`: `listSwarmSessions({ exclude:'archived' })` excludes; `countSwarmSessions({ exclude:'archived' })` counts correctly; `archiveSwarmSession` from `processed` → `archived`; from non-`processed` → error `{error}`; `restoreSwarmSession` from `archived` → `processed`; from non-`archived` → error.
- `drone-coordinator/test/routes/swarm.test.ts`:
  - `POST /sessions/:id/end` from `stale`, `processing`, `processed` → 200 `ended`; from `archived` → 409 (behavior change test).
  - `POST /sessions/:id/archive` from `processed` → 200 `archived`; from `ended`/other → 409; missing → 404.
  - `POST /sessions/:id/restore` from `archived` → 200 `processed`; from `processed` → 409; missing → 404.
  - `GET /sessions?exclude=archived` excludes archived from `sessions` and `count`.
- `drone-beacon/test/sessions.test.ts`: `GET /sessions?exclude=archived` forwards `exclude` to `getSessions`.
- `drone-swarm/test/cli.test.ts`: fixture routes for `/api/sessions/s-1/archive` + `/restore`; test `session archive`/`session restore`; assert bare `session list` sends `exclude=archived` and `--status archived` does not.
- **Deps:** Steps 2–6. **Validated:** `pnpm -r run test` (fast suite).

### Step 8 — Docs
- `docs/agents/memory-pipeline.md`: update lifecycle line + "Status lifecycle" section to `... → processed → archived`; add archive/restore CLI examples; add `session archive` / `session restore` to the command list; note `session list` excludes archived by default.
- `docs/agents/session-import.md`: add `archived` to the `--status S` list.
- `drone-coordinator/README.md`: add `POST /sessions/:id/archive` and `POST /sessions/:id/restore` to the session routes list.
- **Deps:** Steps 1–6 (accurate docs reflect implemented routes). **Validated:** grep for stale lifecycle text; no `'finished'` remaining in status contexts.

### Step 9 — Final check against validation criteria
- See Validation section below. Run the full repo gates.
- **Deps:** ALL. **Validated:** everything green.

## Validation criteria (final step MUST pass all)
1. `SESSION_STATUSES` includes `ARCHIVED: 'archived'`; `SessionStatus` union includes `'archived'`.
2. `GET /api/sessions?exclude=archived` returns only non-archived sessions and `count` excludes them.
3. `POST /api/sessions/:id/end` returns 409 for an `archived` session; 200 `ended` from `stale`/`processing`/`processed`.
4. `POST /api/sessions/:id/archive` only from `processed` → `archived` (404 missing, 409 wrong status).
5. `POST /api/sessions/:id/restore` only from `archived` → `processed` (404 missing, 409 wrong status).
6. Beacon `GET /sessions?exclude=archived` forwards `exclude` to the coordinator client.
7. `drone-swarm session list` (no `--status`) sends `exclude=archived`; `--status archived` lists archived; `session archive <id>` / `session restore <id>` work.
8. UI: default view excludes archived; header toggle switches to archived-only and persists via `?view=archived`; per-row Restore (archived), Archive (processed), End (stale/processing/processed); archived badge renders distinctly.
9. Docs updated: `memory-pipeline.md` lifecycle, `session-import.md` status list, `drone-coordinator/README.md` routes.
10. **All LSP checks pass** (typescript/other connected LSPs; zero errors/warnings introduced).
11. **`pnpm -r run build` passes** (zero errors; drone-core dist rebuilt first after Step 1 if downstream consumes built types).
12. **`pnpm -r run lint` (eslint + prettier) passes** with zero errors.
13. **`pnpm -r run test` passes** (fast suite; coordinator/beacon/swarm/ui tests for this change all green).

## Implementation notes / cautions
- **Don't change** the beacon sync `DELETE /sessions/:id` handler (`routes/sync.ts`) — stays permissive; it is the authoritative end-of-life signal and may end archived sessions.
- The UI page currently references `'finished'` in `getStatusBadge` and the Process-button condition. `'finished'` is a dead status (consolidated to `'ended'` in ADR 093); sweep both occurrences and replace with `'ended'`/`'stale'` as appropriate — use `find-references` on `'finished'` across the UI to catch all.
- `/end` route in `routes/swarm.ts` is used by the UI's `terminate` flow (which first deletes the beacon session, then POSTs `/end`). The guarded `/end` must still allow `active → ended` (it does via the allowed-from list) so Terminate keeps working.
- Keep `GET /sessions` with both `status` AND `exclude` working (they compose as AND in SQL) — the archived view passes only `status=archived`, normal view passes only `exclude=archived`, so they never collide in practice.
- After editing drone-core types, run `pnpm -r run build` before relying on typecheck in downstream packages (they resolve drone-core from built `dist/`).
- The UI toggle URL param must not collide with `usePaginationOffset` (it already owns `offset`); use a separate `view` search param via `useSearchParams`.

## Commits (recommend one per layer, or a single feature commit)
1. drone-core type + coordinator DB/routes + tests
2. beacon passthrough + tests
3. drone-swarm CLI + tests
4. coordinator-ui page + tests
5. docs
6. build/lint/test verification (no code change)