---
tags: [decision, coordinator, coordinator-ui, live-events, api-paths]
related:
  [
    modules/drone-coordinator.md,
    modules/drone-coordinator-ui.md,
    modules/drone-beacon.md,
    decisions/023-conversation-event-push-through.md,
  ]
---

# ADR 089: Coordinator Live Event Streaming + /api Prefix

**Status**: Implemented (commit `1c0bb71`)

## Problem

Two interdependent issues:

1. **Live event streaming was dead**: The `publishEvent()` function existed in `ws-pubsub.ts` but was never called from any route handler. WebSocket clients received initial state but never saw live updates.

2. **SPA path conflicts**: API routes at root level (e.g., `/sessions`, `/personas`) conflicted with SPA client-side routes. The Vite dev server and production build both served the SPA at root, so navigating to `/sessions` in the browser would hit the API instead of the SPA.

## Solution

### Step 1: Add `publishMutationEvent()` helper

Added a convenience wrapper around `publishEvent()` with error handling in `ws-pubsub.ts`.

### Step 2: Wire up critical endpoints

Wired `publishMutationEvent` into 9 handlers across `swarm.ts` and `beacons.ts`:

- `POST /sync/sessions/register` → `session.created`
- `DELETE /sync/sessions/:id` → `session.ended`
- `POST /sync/events/push` → per-event broadcast (the key one for live streaming)
- `POST /sessions/:id/process` → `session.processing`
- `POST /sessions/:id/processed` → `session.processed`
- `POST /agents/location` → `agent.connected`
- `DELETE /agents/location/:agentId` → `agent.disconnected`
- `POST /beacons/:id/sessions` → `beacon.session.created`
- `DELETE /beacons/:id/sessions/:agentId` → `beacon.session.ended`

### Step 3: Prefix all coordinator API routes with /api

Wrapped all route registrations (except health) in a Fastify scoped plugin with `{ prefix: '/api' }` in `routes/index.ts`. Individual route files remained unchanged.

### Step 4: Update beacon coordinator-client.ts URLs

Added `/api` prefix to all 27 coordinator URL references in `drone-beacon/src/coordinator-client.ts`.

### Step 5: Update all UI authFetch calls

Added `/api` prefix to all ~38 authFetch URL calls across 14 UI page files. Login page's `fetch('/health')` left as-is.

### Step 6: Update coordinator test URLs

Added `/api` prefix to all test URLs in 11 test files + 1 gateway test file. Health test left as-is.

## Files Changed

- `drone-coordinator/src/ws-pubsub.ts` — Added `publishMutationEvent()`
- `drone-coordinator/src/routes/swarm.ts` — Wired 7 publishMutationEvent calls
- `drone-coordinator/src/routes/beacons.ts` — Wired 2 publishMutationEvent calls
- `drone-coordinator/src/routes/index.ts` — Added /api prefix to all routes
- `drone-beacon/src/coordinator-client.ts` — Added /api prefix to 27 URLs
- 14 UI page files — Added /api prefix to ~38 authFetch calls
- 11 coordinator test files + 1 gateway test file — Added /api prefix

## Validation

- `pnpm -r run build` passes
- `pnpm lint` passes
- LSP diagnostics clean
- All 1632 tests pass
