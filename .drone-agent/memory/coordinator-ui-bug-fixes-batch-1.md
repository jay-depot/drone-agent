---
key: coordinator-ui-bug-fixes-batch-1
tags:
  - plan
  - coordinator-ui
  - bug-fix
  - completed
created: 2026-07-28T17:07:16.164Z
updated: 2026-07-28T17:24:16.276Z
---

# Plan: Coordinator UI Bug Fixes (Batch 1) — COMPLETED

## Summary

Three bugs in the coordinator UI related to session lifecycle and display were fixed.

## Changes Made

### Step 1: Add `POST /sessions/:id/end` endpoint (coordinator backend)

**File**: `drone-coordinator/src/routes/swarm.ts`
Added a new route handler that uses the existing `updateSwarmSessionStatus()` to force-end a swarm session from any status. Returns 404 if session doesn't exist.

### Step 2: Update terminate flow in sessions UI page

**File**: `drone-coordinator-ui/src/pages/sessions.tsx`
Changed the terminate handler to:

1. Try the beacon DELETE endpoint (may return 404 if already ended)
2. Always call `POST /sessions/:id/end` to update the swarm session status
3. Refresh the list

### Step 3: Fix event ordering and auto-scroll in session detail

**File**: `drone-coordinator-ui/src/pages/session-detail.tsx`
Removed `[...events].reverse()` so events render in chronological order (oldest first). Auto-scroll to bottom now correctly shows the newest events.

### Step 4: Add `countSwarmSessions()` to the database layer

**File**: `drone-coordinator/src/db/swarm-sessions.ts`
Added a function that returns the total count of swarm sessions with optional status filter.
**File**: `drone-coordinator/src/db/index.ts`
Exported `countSwarmSessions` from the barrel file.

### Step 5: Update `/sessions` route to return actual total count

**File**: `drone-coordinator/src/routes/swarm.ts`
Changed `GET /sessions` to use `countSwarmSessions()` instead of `sessions.length` for the `count` field.

### Step 6: Add tests

**File**: `drone-coordinator/test/routes/swarm.test.ts`
Added 4 tests:

- `POST /sessions/:id/end` ends an active session
- `POST /sessions/:id/end` returns 404 for missing session
- `POST /sessions/:id/end` is idempotent on already-ended session
- `GET /sessions` count reflects total, not page size

## Validation

- ✅ `pnpm -r run build` passes
- ✅ `pnpm lint` passes
- ✅ LSP diagnostics clean
- ✅ All 1632 tests pass
- ✅ Changes committed (b09bf9f)
