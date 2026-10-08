---
tags: [decision, swarm, events, bugfix]
related:
  [
    023-conversation-event-push-through.md,
    flows/swarm-connection.md,
    modules/drone-beacon.md,
    modules/drone-coordinator.md,
  ]
---

# 024 — Swarm Event Push 404 Fix and Session Cleanup

**Status**: Implemented (2026-06-30, commit `0ae961a`)

## Context

The drone-agent swarm plugin sends conversation events and session registrations to the beacon, but the beacon was missing proxy routes for these endpoints. This caused `404` errors and lost events. Additionally, swarm sessions were never cleaned up on shutdown — sessions remained in `active` status on the coordinator indefinitely.

## Decision

Add the missing beacon proxy routes, add a swarm session end endpoint on the coordinator, and wire up cleanup on agent shutdown.

### Changes

#### 1. Beacon proxy routes (`drone-beacon/src/routes/sync.ts`)

Three new routes added:

- **`POST /sync/events/push`** — Proxies conversation events to the coordinator via `coordinatorClient.pushEvents()`. Validates that the `events` array is present and non-empty. Fire-and-forget on the coordinator call so a slow coordinator doesn't block the agent.

- **`POST /sync/sessions/register`** — Proxies swarm session registration to the coordinator via `coordinatorClient.registerSwarmSession()`. Validates `id` and `beaconId` are present.

- **`DELETE /sync/sessions/:id`** — Proxies session end to the coordinator via `coordinatorClient.endSwarmSession()`. Returns 502 if the coordinator is not configured.

#### 2. Coordinator session end endpoint (`drone-coordinator/src/routes/swarm.ts`)

- **`DELETE /sync/sessions/:id`** — Marks a swarm session as `ended` using the existing `db.updateSwarmSessionStatus()`. Returns 404 if the session is not found.

#### 3. Coordinator client method (`drone-beacon/src/coordinator-client.ts`)

- **`endSwarmSession(sessionId)`** — Added to both the `CoordinatorClient` interface and the implementation. Sends a `DELETE` request to the coordinator's `/sync/sessions/:id` endpoint. Logs success or failure.

#### 4. Agent shutdown cleanup (`drone-agent/src/plugins/swarm/index.ts`)

In the `onShutdown` hook, after flushing events and unregistering the config injector:

- Sends `DELETE /sync/sessions/{sessionId}` to end the swarm session
- Sends `DELETE /agents/{sessionId}` to deregister the agent (pre-existing, now ordered after session cleanup)

Both calls are wrapped in try-catch to silently ignore cleanup failures.

## Consequences

- The `[swarm] Failed to push N events: 404` message no longer appears during normal operation
- Swarm sessions are marked as `ended` on the coordinator when the agent shuts down
- The beacon proxy pattern is now consistent: all swarm sync endpoints have corresponding beacon proxy routes
- Build, lint, and all 808 tests pass

## Related

- [023-conversation-event-push-through](023-conversation-event-push-through.md) — The hook that generates the events being pushed
- swarm-connection — Connection and shutdown flow
- [drone-beacon](../../drone-beacon/) — Beacon sync routes
- [drone-coordinator](../../drone-coordinator/) — Coordinator swarm routes
