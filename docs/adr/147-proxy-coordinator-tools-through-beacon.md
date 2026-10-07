---
tags: [decision, swarm, coordinator, proxy, beacon, spawn]
related: [architecture/swarm-architecture.md, modules/drone-beacon.md, modules/drone-agent-plugins.md, modules/drone-core.md, entities/DroneAgentConfig.md, decisions/043-inter-beacon-spawn-routing.md, decisions/146-swarm-session-import.md, decisions/024-swarm-event-push-404-fix.md]
---

# 147: Proxy coordinator tools through the beacon + drop `coordinatorUrl`

**Status**: Implemented (2026-08-19)

## Context

The swarm plugin's agent side has a hard architectural rule: **the agent never talks to the coordinator directly** — the beacon is the sole coordinator-facing trust gate (TOFU fingerprint + beacon approval). This was established incrementally:

- The `/swarm-session` feature ([[decisions/146-swarm-session-import]]) already proxied session reads through the beacon (`GET /sessions`, `GET /sessions/:id/transcript`).
- But the six pre-existing **coordinator tools** — `swarm_list_beacons`, `swarm_list_agents`, `swarm_spawn`, `swarm_get_spawn`, `swarm_list_spawns`, `swarm_terminate_spawn` — still hit the coordinator directly via a `coordinatorUrl` config value, bypassing the beacon's trust gate.

The `coordinatorUrl` config itself was a mistake: it was added on the false assumption that the beacon would share the agent's config file, which turned out to be false. Keeping it around caused exactly the kind of direct-coordinator call this refactor removes.

## Decision

### Proxy all 6 coordinator tools through the beacon

- **Beacon `/coordinator/*` proxy routes** (new `drone-beacon/src/routes/coordinator.ts`), reusing the `/coordinator` prefix already used by `coordinator-trust.ts`. Pure pass-through — the beacon does **no** response reshaping; all wrapper logic stays in the agent.
- **Error convention** (mirrors the coordinator's own spawn proxy in `drone-coordinator/src/routes/spawn.ts`): **503** when no `CoordinatorClient` is configured or the coordinator is unreachable; **502** when the coordinator responds non-2xx. In practice the object-returning methods collapse failures to `null`, which the beacon maps to 503.
- **`CoordinatorClient`** gains 6 typed, trust-gated methods (`listBeacons`, `listAgentLocations`, `spawnSpawn`, `getSpawn`, `listSpawns`, `terminateSpawn`), each gated on `coordinatorTrusted()` and calling the coordinator via the existing TLS-aware `cfetch` wrapper.

### Drop `coordinatorUrl` from config entirely

- Removed from `SwarmConfig` (swarm/config.ts) and `DroneSwarmConfig` (drone-core/config-types.ts).
- It was never in the config schema, so no schema change was needed.
- The swarm plugin no longer reads it; the agent tools now take the beacon `baseUrl` and hit `${baseUrl}/coordinator/...`.
- **Scope exclusions:** the **gateway's** `coordinatorUrl` is a separate, legitimate config (the gateway genuinely connects to the coordinator for coordinator spawn mode) — untouched. The `drone-agent/test/fixtures/swarm.ts` `coordinatorUrl` references are integration-test harnesses hitting the coordinator directly in the isolated Docker swarm — untouched.

## The 6 tools → CoordinatorClient methods → coordinator endpoints

| Agent tool | CoordinatorClient method | Coordinator endpoint |
|---|---|---|
| swarm_list_beacons | listBeacons() | GET /api/beacons |
| swarm_list_agents | listAgentLocations(beaconId?) | GET /api/agents/location |
| swarm_spawn | spawnSpawn(body) | POST /api/spawn |
| swarm_get_spawn | getSpawn(beaconId, spawnId) | GET /api/spawn/:beaconId/:spawnId |
| swarm_list_spawns | listSpawns(beaconId, status?) | GET /api/spawn/:beaconId |
| swarm_terminate_spawn | terminateSpawn(beaconId, spawnId) | DELETE /api/spawn/:beaconId/:spawnId |

## Key Points

- The agent never talks to the coordinator directly for any operation — session reads (`/sessions`) and the 6 spawn/info tools (`/coordinator/*`) all proxy through the beacon.
- The beacon is the **sole coordinator-facing trust gate** (TOFU fingerprint + beacon approval), enforced by `coordinatorTrusted()` on every CoordinatorClient method.
- The dead `coordinatorUrl` agent config is gone; the swarm plugin only needs `beaconHost`/`beaconPort`.
- The beacon proxy is a **pure pass-through** — no response reshaping.
- The gateway keeps its own `coordinatorUrl` (legitimate separate use); integration-test fixtures unaffected.
- Validation: `pnpm -r run build`/`typecheck`/`lint` clean, fast suite 2044 passed / 9 skipped.

## Related

- [[architecture/swarm-architecture]] — The swarm plugin's coordinator tools
- [[modules/drone-beacon]] — `/coordinator/*` proxy routes + CoordinatorClient methods
- [[modules/drone-agent-plugins]] — swarm plugin tools now hit the beacon proxy
- [[modules/drone-core]] — `DroneSwarmConfig` no longer has `coordinatorUrl`
- [[entities/DroneAgentConfig]] — swarm config section corrected
- [[decisions/146-swarm-session-import]] — The prior step that proxied session reads through the beacon
- [[decisions/043-inter-beacon-spawn-routing]] — The original coordinator spawn/info tools
- [[decisions/024-swarm-event-push-404-fix]] — Beacon proxy routes design precedent
