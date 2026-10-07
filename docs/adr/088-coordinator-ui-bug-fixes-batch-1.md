---
tags: [decision, coordinator-ui, bug-fix]
related: [modules/drone-coordinator-ui.md, modules/drone-coordinator.md, decisions/031-session-processing-pipeline.md]
---

# ADR 088: Coordinator UI Bug Fixes (Batch 1)

**Status**: Implemented (commit `b09bf9f`)

## Problem

Three bugs in the coordinator UI related to session lifecycle and display:

1. **Terminate flow broken**: The UI tried to call `DELETE /beacons/:id/sessions/:agentId` to terminate a session, but this endpoint returns 404 if the beacon session is already ended. There was no fallback to update the swarm session status.

2. **Event ordering reversed**: The session detail page used `[...events].reverse()` to show newest events first, but this reversed the chronological order — events were shown newest-to-oldest instead of oldest-to-newest.

3. **Pagination count incorrect**: `GET /sessions` returned `sessions.length` as the `count` field, which reflected the page size, not the total number of sessions.

## Solution

### Step 1: Add `POST /sessions/:id/end` endpoint

Added a new route handler in `drone-coordinator/src/routes/swarm.ts` that uses the existing `updateSwarmSessionStatus()` to force-end a swarm session from any status. Returns 404 if session doesn't exist.

### Step 2: Update terminate flow in sessions UI

Changed the terminate handler to:
1. Try the beacon DELETE endpoint (may return 404 if already ended)
2. Always call `POST /sessions/:id/end` to update the swarm session status
3. Refresh the list

### Step 3: Fix event ordering

Removed `[...events].reverse()` in session detail page so events render in chronological order (oldest first). Auto-scroll to bottom now correctly shows the newest events.

### Step 4: Add `countSwarmSessions()` to database layer

Added a function that returns the total count of swarm sessions with optional status filter. Exported from the barrel file.

### Step 5: Update `/sessions` route to return actual total count

Changed `GET /sessions` to use `countSwarmSessions()` instead of `sessions.length` for the `count` field.

## Files Changed

- `drone-coordinator/src/routes/swarm.ts` — Added `POST /sessions/:id/end`, fixed count
- `drone-coordinator/src/db/swarm-sessions.ts` — Added `countSwarmSessions()`
- `drone-coordinator/src/db/index.ts` — Exported `countSwarmSessions`
- `drone-coordinator-ui/src/pages/sessions.tsx` — Updated terminate flow
- `drone-coordinator-ui/src/pages/session-detail.tsx` — Fixed event ordering
- `drone-coordinator/test/routes/swarm.test.ts` — Added 4 tests

## Validation

- `pnpm -r run build` passes
- `pnpm lint` passes
- LSP diagnostics clean
- All 1632 tests pass (4 new tests for end-session endpoint)
