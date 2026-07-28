---
key: fix__session-status-mismatch
tags:
  []
created: 2026-07-28T22:52:53.195Z
updated: 2026-07-28T23:09:54.310Z
---

# Fix: Beacon End-Session / Pipeline Status Mismatch

## Summary

The beacon's `endSwarmSession()` calls `DELETE /sync/sessions/:id` on the coordinator, which sets status to `'ended'`. But the pipeline's `POST /sessions/:id/process` only allows transitions from `['active', 'stale', 'finished']`. So `'ended'` sessions are dead-ended — they can never enter the processing pipeline.

## Root Cause

Two code paths use different status terminology:
- **End-session path** (beacon → coordinator): sets `'ended'`
- **Pipeline path** (coordinator): expects `'finished'` as a pre-processing terminal status

Additionally, `'stale'` is defined in `SESSION_STATUSES` and referenced in the pipeline transition validation, but no code path ever sets it.

## Changes

### Step 1: Update `SESSION_STATUSES` in `drone-core/src/session-types.ts`
Replace `FINISHED: 'finished'` with `ENDED: 'ended'`.

### Step 2: Update pipeline allowed from-statuses in `drone-coordinator/src/routes/swarm.ts`
Change from `['active', 'stale', 'finished']` to `['active', 'stale', 'ended']`.

### Step 3: Add `markStaleSessions()` DB function in `drone-coordinator/src/db/swarm-sessions.ts`
Add a function that calls the existing `getStaleSessions()` and updates each found session to `'stale'`. Export it from `drone-coordinator/src/db/index.ts`.

### Step 4: Add `POST /sessions/mark-stale` route in `drone-coordinator/src/routes/swarm.ts`
Add a route that calls `markStaleSessions()` with an optional `thresholdMs` query parameter (default: 30 minutes).

### Step 5: Add automatic stale-marking interval in `drone-coordinator/src/index.ts`
Set up a `setInterval` that calls `markStaleSessions(30 * 60 * 1000)` every 5 minutes. Clean up on shutdown.

### Step 6: Update tests
- `drone-coordinator/test/db.test.ts`: Update `'completed'` → `'ended'` in the `updateSwarmSessionStatus` test
- `drone-coordinator/test/routes/swarm.test.ts`: Add tests for processing an ended session, marking stale sessions

### Step 7: Build, typecheck, lint, and test
All pass. 104 test files, 1636 tests passed.

## Validation Criteria
1. ✅ `SESSION_STATUSES` has `ENDED: 'ended'` and no `FINISHED`
2. ✅ `POST /sessions/:id/process` allows transition from `'ended'` to `'processing'`
3. ✅ `markStaleSessions()` exists and is exported
4. ✅ `POST /sessions/mark-stale` route exists and works
5. ✅ Automatic stale marking runs on coordinator startup
6. ✅ All existing tests pass
7. ✅ New tests cover: processing an ended session, marking stale sessions
8. ✅ `pnpm build` passes
9. ✅ `pnpm typecheck` passes
10. ✅ `pnpm -r run lint` passes
11. ✅ `pnpm -r run test` passes

## Commit
`d430737` on branch `fix/session-status-mismatch`

## Wiki Ingest
Ingested into project wiki at commit `c214b31`:
- New decision: `decisions/093-session-status-mismatch-fix.md`
- Updated: `concepts/session-processing-pipeline.md`, `modules/drone-core.md`, `modules/drone-coordinator.md`, `index.md`, `log.md`, `meta.json`