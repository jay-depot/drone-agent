---
key: plan-swarm-tools-coordinator-refactor
tags:
  - plan
  - swarm
  - coordinator
  - refactor
  - proxy
created: 2026-08-19T00:54:50.926Z
updated: 2026-08-19T00:54:50.926Z
---

# Plan: Proxy coordinator tools through the beacon + drop `coordinatorUrl`

## Summary

Rework the six pre-existing direct-coordinator tools in the swarm plugin (`swarm_list_beacons`, `swarm_list_agents`, `swarm_spawn`, `swarm_get_spawn`, `swarm_list_spawns`, `swarm_terminate_spawn`) to proxy through the beacon, consistent with how everything else in the swarm plugin works (agent → beacon → coordinator). This completes the "agent never talks to the coordinator directly" goal and removes the now-dead `coordinatorUrl` config, which was originally added on the false assumption that the beacon would share the agent's config file — keeping it causes mistakes like the direct-coordinator calls this refactor removes.

## Decisions (locked with user)

- **Drop `coordinatorUrl` from config entirely.** It leaves `SwarmConfig` (swarm/config.ts), `DroneSwarmConfig` (drone-core/config-types.ts), and the swarm plugin stops reading it. It was never in the config schema.
- **Beacon `/coordinator/*` proxy routes** in a new `routes/coordinator.ts`, reusing the `/coordinator` prefix already used by `coordinator-trust.ts`. The beacon is a PURE pass-through (no response reshaping); all wrapper logic stays in the agent.
- **Beacon error convention** (mirrors the coordinator's own spawn proxy in `drone-coordinator/src/routes/spawn.ts`):
  - **503** when no `CoordinatorClient` is configured OR the coordinator is unreachable
  - **502** when the coordinator responds non-2xx
- **Scope exclusions:** the gateway's `coordinatorUrl` is a separate, legitimate config (gateway genuinely connects to the coordinator for coordinator spawn mode) — untouched. The `drone-agent/test/fixtures/swarm.ts` `coordinatorUrl` references are integration-test fixtures that hit the coordinator directly in the isolated Docker swarm — untouched.

## The 6 tools → CoordinatorClient methods → coordinator endpoints

| Agent tool | CoordinatorClient method | Coordinator endpoint |
|---|---|---|
| swarm_list_beacons | listBeacons() | GET /api/beacons |
| swarm_list_agents | listAgentLocations(beaconId?) | GET /api/agents/location |
| swarm_spawn | spawnSpawn(body) | POST /api/spawn |
| swarm_get_spawn | getSpawn(beaconId, spawnId) | GET /api/spawn/:beaconId/:spawnId |
| swarm_list_spawns | listSpawns(beaconId, status?) | GET /api/spawn/:beaconId |
| swarm_terminate_spawn | terminateSpawn(beaconId, spawnId) | DELETE /api/spawn/:beaconId/:spawnId |

## Phases

### Phase 1 — CoordinatorClient: add 6 typed, trust-gated methods
`drone-beacon/src/coordinator-client.ts` (interface lines ~40-120 + implementations). Each calls the coordinator via the existing TLS-aware `cfetch` wrapper and is gated on `coordinatorTrusted()` like the session methods (`getSessionLog` etc.):
- `listBeacons()` → GET `/api/beacons`
- `listAgentLocations(beaconId?)` → GET `/api/agents/location?beaconId=`
- `spawnSpawn(body)` → POST `/api/spawn`
- `getSpawn(beaconId, spawnId)` → GET `/api/spawn/:beaconId/:spawnId`
- `listSpawns(beaconId, status?)` → GET `/api/spawn/:beaconId?status=`
- `terminateSpawn(beaconId, spawnId)` → DELETE `/api/spawn/:beaconId/:spawnId`

### Phase 2 — Beacon `/coordinator/*` proxy routes
New `drone-beacon/src/routes/coordinator.ts`, registered in `routes/index.ts`. Six routes mapping 1:1 to the six client methods. Pure pass-through (no reshaping). Errors: 503 when no CoordinatorClient or coordinator unreachable; 502 when coordinator non-2xx.

### Phase 3 — Remove `coordinatorUrl` from config (dead)
- `drone-agent/src/plugins/swarm/config.ts:12` — remove `coordinatorUrl?: string`
- `drone-core/src/config-types.ts:243` — remove from `DroneSwarmConfig`
- `drone-core/src/config-schema.ts` — confirm absent (it is; `coordinatorUrl` was never in the schema, only the type)
- `drone-agent/src/plugins/swarm/index.ts:74-75` — stop reading it; `:202` — `createCoordinatorTools(coordinatorUrl)` → `createCoordinatorTools(baseUrl)`

### Phase 4 — Agent: retarget the 6 tools to the beacon
`drone-agent/src/plugins/swarm/tools-coordinator.ts`:
- `createCoordinatorTools(coordinatorUrl)` → `createCoordinatorTools(baseUrl)`
- `coordinatorFetch(coordinatorUrl, path)` → `coordinatorFetch(baseUrl, path)`; paths become `/coordinator/...`
- `handleCoordinatorResponse`/`handleCoordinatorError` wrappers stay unchanged (agent still returns `{success:true,...}` / `{success:false,error,details}`)

### Phase 5 — Tests
- `drone-agent/test/swarm-spawn.test.ts` — significant updates:
  - Remove all `createSwarmPlugin({ coordinatorUrl: ... })` and `createDefaultAgentConfig({ swarm: { coordinatorUrl: ... } })`.
  - Change URL assertions from `http://localhost:3456/...` to `http://localhost:3457/coordinator/...` (beacon baseUrl).
  - The "error when coordinatorUrl not configured" tests → "error when beacon returns 503 (coordinator unavailable)" (beacon 503 → agent maps to `{success:false}`).
- `drone-beacon/test/` — new tests for `routes/coordinator.ts`: mock `CoordinatorClient` via `setCoordinatorClient`; test pass-through, 502, 503. Plus `CoordinatorClient` method tests in `coordinator-client.test.ts` (trust-gated, correct `/api` paths).

### Phase 6 — Docs
- Remove any `coordinatorUrl` references in swarm docs. Add a note that the swarm plugin now proxies all coordinator traffic through the beacon.

## Execution order
Phase 1 (client methods) → Phase 2 (beacon routes) → Phase 4 (agent tools) → Phase 3 (config removal, after tools stop using coordinatorUrl) → Phase 5 (tests) → Phase 6 (docs).

## Validation criteria
- LSP passes (typescript, yaml, json, dockerfile, css, html) with zero errors.
- `pnpm -r run lint`, `pnpm -r run build`, `pnpm -r run typecheck` all pass with zero errors.
- Fast test suite (`pnpm -r run test`) passes.
- No remaining `coordinatorUrl` references in the swarm plugin (except gateway + integration-test fixtures, which are separate).
- `swarm-spawn.test.ts` updated; new beacon route + CoordinatorClient tests cover pass-through, 502, and 503.

## Deferred / out of scope
- `drone-gateway` `coordinatorUrl` — separate legitimate config, untouched.
- `drone-agent/test/fixtures/swarm.ts` `coordinatorUrl` — integration-test harness hitting the coordinator directly in the isolated Docker swarm; fine as-is.
