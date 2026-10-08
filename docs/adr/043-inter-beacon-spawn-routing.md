---
tags:
  - decision
  - swarm
related:
  - drone-coordinator.md
  - swarm-architecture.md
  - 012-agent-spawn.md
  - 009-cross-beacon-messaging.md
---

# ADR 043: Inter-Beacon Spawn Routing

**Status**: Accepted (2026-07-05)

## Context

The beacon already has a local spawn API (`POST /spawn`) that spawns agent processes on the same host. The coordinator tracks agent locations and beacon host:port mappings. What was missing was the ability to spawn an agent on a remote beacon through the coordinator — a unified control plane entry point for agent lifecycle management across the swarm.

## Decision

Add a `POST /spawn` route to the coordinator that accepts spawn requests and forwards them to a target beacon, mirroring the existing message relay pattern in `routes/messages.ts`. Also add proxy routes for spawn status queries and termination, plus LLM-facing tools in the swarm plugin.

## Rationale

- **Unified API**: The coordinator becomes the single control plane entry point for spawning agents anywhere in the swarm
- **Consistent pattern**: Follows the exact same two-step lookup (beaconId → host:port) and `fetch()` forwarding pattern as the message relay
- **No beacon changes needed**: The beacon's existing `/spawn` endpoint already accepts forwarded requests — no changes required on the beacon side
- **LLM-accessible**: The swarm plugin exposes 6 tools so agents can discover topology, spawn, check status, list spawns, and terminate

## Implementation

### Coordinator Routes (in `drone-coordinator/src/routes/spawn.ts`)

| Route                              | Purpose                                              | Error Codes                                                                                        |
| ---------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `POST /spawn`                      | Spawn agent on target beacon                         | 400 (missing targetBeaconId), 404 (BEACON_NOT_FOUND), 502 (beacon error), 503 (BEACON_UNAVAILABLE) |
| `GET /spawn/:beaconId`             | List spawns on a beacon (optional `?status=` filter) | 404, 502, 503                                                                                      |
| `GET /spawn/:beaconId/:spawnId`    | Get spawn status                                     | 404, 502, 503                                                                                      |
| `DELETE /spawn/:beaconId/:spawnId` | Terminate a spawned agent                            | 404, 502, 503                                                                                      |

All routes follow the same pattern:

1. Validate the beacon exists via `db.getBeacon(beaconId)` → 404 if not found
2. Forward the request to the beacon via `fetch()`, with the target built by a `buildBeaconUrl()` helper using `URL` objects (hostname/port/pathname/searchParams) instead of string interpolation — hardens against URL-injection from beacon host/port values (CodeQL #50)
3. On beacon error → 502 with the beacon's error text
4. On network error → 503 with `BEACON_UNAVAILABLE`

### LLM Tools (in `drone-agent/src/plugins/swarm/index.ts`)

| Tool                    | Calls Coordinator                  | Parameters                                                           |
| ----------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| `swarm_list_beacons`    | `GET /beacons`                     | (none)                                                               |
| `swarm_list_agents`     | `GET /agents/location`             | `beaconId?`                                                          |
| `swarm_spawn`           | `POST /spawn`                      | `targetBeaconId` (req), `personaId?`, `task?`, `config?`, `spawnId?` |
| `swarm_get_spawn`       | `GET /spawn/:beaconId/:spawnId`    | `beaconId` (req), `spawnId` (req)                                    |
| `swarm_list_spawns`     | `GET /spawn/:beaconId`             | `beaconId` (req), `status?`                                          |
| `swarm_terminate_spawn` | `DELETE /spawn/:beaconId/:spawnId` | `beaconId` (req), `spawnId` (req)                                    |

### Config

Added `coordinatorUrl` to both `SwarmConfig` (plugin interface) and `DroneSwarmConfig` (drone-core type). All tools return a clear error message if `coordinatorUrl` is not configured.

### Design Decisions

- **`targetBeaconId` is required** — no auto-selection in this pass. The "least-loaded beacon" routing was deferred as it would need configuration (opt-in, trust filtering) and is not needed for the initial use case.
- **Plain HTTP forwarding** — same as message relay, no TLS between coordinator and beacons
- **No coordinator-side persistence** — spawn records live only on the target beacon, the coordinator is a stateless relay
- **Registration-capture test pattern** — the swarm plugin's `register()` returns early if beacon registration fails, so tools registered after that point never get added. Tests use a registration-capture pattern (calling `plugin.register()` with a mock registration that records tools) rather than `createDronePluginEngine` with `vi.stubGlobal('fetch')`, since `vi.stubGlobal` doesn't propagate through vitest's fork pool.

## Consequences

- Agents can be spawned on any registered beacon through the coordinator
- LLM agents can discover swarm topology and manage remote agent lifecycles
- The coordinator becomes the single control plane for agent lifecycle
- Users must configure `swarm.coordinatorUrl` in their drone-agent config to use the spawn tools
- No auto-selection of target beacon — users must specify which beacon to spawn on

## Related

- [012-agent-spawn](012-agent-spawn.md) — Beacon-level agent spawn execution
- [009-cross-beacon-messaging](009-cross-beacon-messaging.md) — Cross-beacon message relay (same forwarding pattern)
- [drone-coordinator](../../drone-coordinator/) — Coordinator implementation
- swarm-architecture — Swarm mode
