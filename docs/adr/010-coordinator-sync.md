---
tags:
  - decision
  - swarm
related:
  - drone-beacon.md
  - drone-coordinator.md
---

# ADR 010: Coordinator Sync — Sessions and Knowledge Push/Pull

**Status**: Accepted (2026-06-25)

## Context

Beacons needed to synchronize data with the coordinator. Initially only pull on startup was supported. Full bidirectional sync was needed for swarm-wide coordination.

## Decision

Implement bidirectional sync: beacons push sessions and local knowledge to the coordinator, and pull swarm-wide knowledge from the coordinator. Sync is configurable with intervals.

## Rationale

- **Bidirectional**: Beacons push local changes up, pull swarm-wide changes down
- **Configurable**: Sync intervals, push/pull toggles per feature
- **Incremental**: Only sync changes since last sync (timestamp-based)
- **Resilient**: Failures are logged, local operations continue

## Implementation

- `beacon_sessions` table on coordinator tracks agent sessions per beacon
- Push: beacon sends session events and local knowledge changes to coordinator
- Pull: beacon fetches swarm-wide personas, skills, and config from coordinator
- Periodic sync with configurable interval (default 5 minutes)
- Config options: `sync.pushKnowledge`, `sync.pullIntervalMinutes`, `sync.pushSessions`

## Consequences

- Coordinator has visibility into all agent sessions across beacons
- Local knowledge can be shared swarm-wide
- Swarm-wide knowledge is pulled to all beacons
- Sync failures don't block local operations

## Related

- [[drone-beacon]] — Beacon implementation
- [[drone-coordinator]] — Coordinator implementation
