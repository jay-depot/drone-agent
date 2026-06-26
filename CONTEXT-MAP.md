# Context Map

## Contexts

- [drone-agent](./drone-agent/CONTEXT.md) — CLI worker that embodies personas and executes tasks
- [drone-beacon](./drone-beacon/CONTEXT.md) — Local sync hub for agents on same host or LAN
- [drone-coordinator](./drone-coordinator/CONTEXT.md) — Central hub connecting beacons for swarm-wide coordination

## Relationships

- **drone-agent ↔ drone-beacon**: Agent connects to beacon for local skills/memories; beacon spawns agents on request
- **drone-beacon ↔ drone-coordinator**: Beacon registers with coordinator; syncs skills/personas swarm-wide
- **drone-agent ↔ drone-coordinator**: Indirect via beacon — agent accesses swarm resources through beacon