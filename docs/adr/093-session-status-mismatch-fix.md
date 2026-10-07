---
tags: [decision, session-pipeline, coordinator]
related: [concepts/session-processing-pipeline.md, decisions/031-session-processing-pipeline.md, modules/drone-core.md, modules/drone-coordinator.md]
---

# Decision 093: Session Status Mismatch Fix — Consolidate `finished` → `ended`, Add Auto Stale-Marking

**Status**: Implemented on branch `fix/session-status-mismatch`, commit `d430737`.

## Problem

The beacon's `endSwarmSession()` calls `DELETE /sync/sessions/:id` on the coordinator, which sets status to `'ended'`. But the pipeline's `POST /sessions/:id/process` only allowed transitions from `['active', 'stale', 'finished']`. So `'ended'` sessions were dead-ended — they could never enter the processing pipeline.

Additionally, `'stale'` was defined in `SESSION_STATUSES` and referenced in the pipeline transition validation, but no code path ever set it.

## Solution

Three changes were made:

### 1. Name Consolidation

Replaced `FINISHED: 'finished'` with `ENDED: 'ended'` in `SESSION_STATUSES` (`drone-core/src/session-types.ts`). Updated the pipeline's allowed from-statuses from `['active', 'stale', 'finished']` to `['active', 'stale', 'ended']`.

### 2. Auto Stale-Marking

Added `markStaleSessions()` DB function that calls the existing `getStaleSessions()` and updates each found session to `'stale'`. Exposed via `POST /sessions/mark-stale` route with an optional `thresholdMs` query parameter (default: 24 hours).

### 3. Automatic Interval

Set up a `setInterval` in `drone-coordinator/src/index.ts` that calls `markStaleSessions(30 * 60 * 1000)` every 5 minutes. Cleaned up on shutdown via `clearInterval`.

## Updated Session Lifecycle

```
active ──(>24h no activity)─────→ stale
active ──(agent shutdown)──────→ ended
stale  ──(agent shutdown)──────→ ended
ended  ──(POST /process)───────→ processing
processing ──(POST /processed)──→ processed
```

## Files Changed

- `drone-core/src/session-types.ts` — `FINISHED` → `ENDED`
- `drone-coordinator/src/db/swarm-sessions.ts` — Added `markStaleSessions()`
- `drone-coordinator/src/db/index.ts` — Exported `markStaleSessions`
- `drone-coordinator/src/routes/swarm.ts` — Updated pipeline from-statuses, added `POST /sessions/mark-stale`
- `drone-coordinator/src/index.ts` — Added stale-check interval
- `drone-coordinator/test/db.test.ts` — Updated `'completed'` → `'ended'`
- `drone-coordinator/test/routes/swarm.test.ts` — Added ended-session processing test, mark-stale route tests

## Validation

- `pnpm build` passes
- `pnpm typecheck` passes
- `pnpm -r run lint` passes
- `pnpm -r run test` — 104 files, 1636 tests, all pass
