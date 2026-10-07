---
tags:
  - decision
  - swarm
related:
  - drone-beacon.md
  - subagent.md
---

# ADR 012: Agent Spawn Execution via Beacon

**Status**: Accepted (2026-06-24)

## Context

The beacon needed the ability to spawn new agent processes on demand. This is foundational for coordinator-directed spawning, gateway-initiated conversations, and distributed task routing.

## Decision

Implement a spawn system in the beacon with a `spawns` table, `spawner.ts` module, and REST API endpoints.

## Rationale

- **Foundational**: Enables coordinator-directed, gateway-initiated, and scheduled spawning
- **Tracked lifecycle**: Spawn records track status through spawning → running → terminated/failed
- **Configurable**: Spawn binary path, timeout, and concurrency limits

## Implementation

- `spawns` table: `id`, `agent_id`, `persona_id`, `task`, `config_json`, `status`, timestamps
- `spawner.ts` module: child process management, timeout handling
- REST endpoints: `POST /spawn`, `GET /spawn`, `GET /spawn/:id`, `DELETE /spawn/:id`
- Spawned agents receive CLI args: `--swarm`, `--session-id`, `--beacon-host`, `--beacon-port`, `--persona`, `--task`

## Consequences

- Beacon can spawn agents on demand
- Spawn lifecycle is tracked and queryable
- Spawned agents auto-connect to the beacon
- Concurrency limits prevent resource exhaustion

## Related

- [[drone-beacon]] — Beacon implementation
- [[subagent]] — Subagent spawning
