---
tags: [decision, session-pipeline, coordinator]
related:
  [
    entities/Session.md,
    modules/drone-coordinator.md,
    decisions/030-default-hidden-tool-gating.md,
  ]
---

# ADR 031: Session Processing Pipeline

**Summary**: A full session lifecycle management system on the coordinator, with status transitions (active → stale → finished → processing → processed) and endpoints for listing, retrieving, and processing sessions.

## Context

Sessions needed a defined lifecycle to support automated knowledge management. The coordinator stored swarm sessions with only `active`/`ended` statuses, and there was no way to reconstruct a full conversation log from stored events (large payloads were offloaded to blob files with no retrieval endpoint).

## Decision

Expand the `swarm_sessions.status` field to support the full lifecycle: `active`, `stale`, `finished`, `processing`, `processed`. Add a `transitionSessionStatus()` function with from-status validation to prevent invalid transitions.

Add the following endpoints:

- `GET /sessions` — list sessions with status filter, sorting, pagination
- `GET /sessions/:id/log` — reconstruct full conversation from events, resolving blob references
- `POST /sessions/:id/process` — mark as `processing`, return session log
- `POST /sessions/:id/processed` — mark as `processed`, accept summary/notes

The pipeline is composable: `POST /sessions/:id/process` just marks state and returns data — it doesn't spawn agents. The human (or cron) decides how to feed the data to an agent.

## Consequences

- **Positive**: Sessions have a clear lifecycle that enables automated processing
- **Positive**: Full conversation logs can be reconstructed from stored events
- **Positive**: The pipeline is composable — no coupling between state management and agent spawning
- **Positive**: Stale detection can be added as a background job
- **Neutral**: Large payloads (>10KB) are still offloaded to blob files, but now retrievable

## Implementation

- `SESSION_STATUSES` constants in `drone-core/src/session-types.ts`
- `transitionSessionStatus()`, `getStaleSessions()` in coordinator DB
- Enhanced `listSwarmSessions()` with sorting/pagination options
- Coordinator routes for all session pipeline endpoints
- `CoordinatorClient` methods for beacon proxying

## Source

Commits `4e5bbf6` (Phase 1 types), `ed8e4c4` (Phase 3 routes), `ef3945e` (Phase 5 client)
