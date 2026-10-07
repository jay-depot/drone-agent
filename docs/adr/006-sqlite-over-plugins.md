---
tags:
  - decision
  - swarm
related:
  - drone-beacon.md
  - drone-coordinator.md
---

# ADR 006: SQLite at Beacon/Coordinator, Not Pluggable Storage

**Status**: Accepted (2026-06-18)

## Context

The beacon and coordinator needed storage backends. Options included: pluggable storage engines, SQLite-only, or SQLite/Postgres.

## Decision

Use SQLite at the beacon level, SQLite or Postgres at the coordinator level. No pluggable storage engine at either level.

## Rationale

- **Simplicity**: Plugin engines at every layer of the stack are a maintenance nightmare
- **SQLite is sufficient**: For a single-user swarm, SQLite handles the load
- **Coordinator flexibility**: Postgres is available for multi-writer scenarios at the coordinator level
- **Fixed storage, pluggable behavior**: At the agent level, retention strategy and memory indexing are behavioral concerns implemented as plugins, not storage backends

## Consequences

- Beacon always uses SQLite
- Coordinator can use SQLite or Postgres
- No plugin system for storage backends at beacon/coordinator
- Agent-level memory plugins control what gets retained and how it's indexed, but the where shifts from files to beacon database when swarm is active

## Related

- [[drone-beacon]] — Beacon implementation
- [[drone-coordinator]] — Coordinator implementation
