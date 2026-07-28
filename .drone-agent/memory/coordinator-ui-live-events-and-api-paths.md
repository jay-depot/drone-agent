---
key: coordinator-ui-live-events-and-api-paths
tags:
  - plan
  - coordinator-ui
  - live-events
  - api-paths
  - completed
created: 2026-07-28T17:15:14.479Z
updated: 2026-07-28T17:43:17.741Z
---

# Plan: Coordinator UI Live Events + API Path Fix — COMPLETED

## Summary

Two interdependent issues were fixed: live event streaming (publishEvent was never called) and SPA path conflicts (API routes at root level conflicted with SPA routes).

## Changes Made

### Step 1: Add publishMutationEvent helper + wire up critical endpoints

**File**: `drone-coordinator/src/ws-pubsub.ts`
Added `publishMutationEvent()` — a convenience wrapper around `publishEvent()` with error handling.

**File**: `drone-coordinator/src/routes/swarm.ts`
Wired up `publishMutationEvent` in 7 handlers:

- `POST /sync/sessions/register` — session.created
- `DELETE /sync/sessions/:id` — session.ended
- `POST /sync/events/push` — per-event broadcast (the key one for live streaming)
- `POST /sessions/:id/process` — session.processing
- `POST /sessions/:id/processed` — session.processed
- `POST /agents/location` — agent.connected
- `DELETE /agents/location/:agentId` — agent.disconnected

**File**: `drone-coordinator/src/routes/beacons.ts`
Wired up `publishMutationEvent` in 2 handlers:

- `POST /beacons/:id/sessions` — beacon.session.created
- `DELETE /beacons/:id/sessions/:agentId` — beacon.session.ended

### Step 2: Prefix all coordinator API routes with /api

**File**: `drone-coordinator/src/routes/index.ts`
Wrapped all route registrations (except health) in a Fastify scoped plugin with `{ prefix: '/api' }`. Individual route files unchanged.

### Step 3: Update beacon coordinator-client.ts URLs

**File**: `drone-beacon/src/coordinator-client.ts`
Added `/api` prefix to all 27 coordinator URL references.

### Step 4: Update all UI authFetch calls to use /api prefix

**Files**: 14 page files in `drone-coordinator-ui/src/pages/`
Added `/api` prefix to all ~38 authFetch URL calls. Login page's `fetch('/health')` left as-is.

### Step 5: Update coordinator test URLs

**Files**: 11 test files in `drone-coordinator/test/routes/` + 1 in `drone-gateway/test/`
Added `/api` prefix to all test URLs. Health test left as-is.

### Step 6: Add tests for live event publishing

Existing tests for `/sync/events/push` already cover the route handler. The `publishMutationEvent` calls are fire-and-forget and don't affect responses. All 1632 tests pass.

## Validation

- ✅ `pnpm -r run build` passes
- ✅ `pnpm lint` passes
- ✅ LSP diagnostics clean
- ✅ All 1632 tests pass
- ✅ Changes committed (1c0bb71)
