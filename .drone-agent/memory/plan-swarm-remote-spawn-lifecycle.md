---
key: plan-swarm-remote-spawn-lifecycle
tags:
  - plan
  - swarm
  - spawn
  - lifecycle
  - remote-subagent
created: 2026-09-03T03:30:33.745Z
updated: 2026-09-03T03:30:33.745Z
---

# Plan: Swarm remote-spawn lifecycle (sync + async remote dispatch for agent sessions)

## Feature

Make swarm remote spawn a first-class, lifecycle-managed primitive for agent-to-agent calls, modeled on the proven local-subagent conventions. One `swarm_spawn` tool gains `mode: sync | async`. Both run the child as a JSON single-shot agent; sync returns the result by **push** over the caller's WS connection; async fires and the caller polls a stored result. Spawned agents reuse subagent `return`/`stopLoop` conventions and can spawn subagents (headless main agent).

## Architecture map (as found)

- Caller surfaces: agent swarm tools (tools-coordinator.ts) → beacon `/coordinator/*` proxy → coordinator `/api/spawn` → reverse channel → beacon `handleSpawnAgent` → shared spawner (drone-swarm-common); gateway `CoordinatorSpawnBackend`; coordinator session-end trigger.
- Spawn record (beacon SQLite `spawns`): `spawning→running`(POST /agents)→`failed|terminated`. Coordinator = stateless relay (ADR 43).
- Shared spawner: `spawn(...)`, pipes stdin/stdout, debug-logs stdout only, `terminateAgent` SIGTERM→SIGKILL 5s, maxConcurrentSpawns, 4096 workingDir cap.
- Cross-beacon relay machinery to reuse: coordinator `routes/messages.ts` `/messages/relay` → `sendBeaconCommand('deliverMessage')` → beacon `sendToAgent` (WS).
- Config: `DroneSwarmConfig` already has `beaconHost`/`beaconPort`/`beaconUseHttps`/`sessionId` (drone-core/config-types.ts:307-314).
- Agent WS is a single `onmessage` dispatcher (websocket.ts) → sync wait must use a pending-result registry in SwarmContext.

## Decisions locked

1. One `swarm_spawn` with `mode: "sync" | "async"` (default pending; ADR 068/071 action-param).
2. Result collection = push terminal `spawnResult` over caller's WS (`sendToAgent`). Beacon pipes child stdout, parses `return` NDJSON, stores result/exitCode on spawn record, pushes to caller. Live streaming = follow-up.
3. Child signal: dedicated `swarmSpawned` runtime flag (NOT `isSubagent`). Reuse subagent `return`/`stopLoop` + `subagent__return` name.
4. Spawned agents CAN spawn subagents (`isSubagent` false → `dispatch` registers; verified OK under runJsonMode — subagent child stdout is piped to dispatch's on-data, never process.stdout, so no NDJSON corruption).
5. Sync timeout: hard wall-clock cap, generous; `{ timedOut, ... }`; reconcile via `swarm_get_spawn` on interrupt. Activity-based = follow-up.
6. Shared spawner ALWAYS passes `--output-json`; `singleShot` is OPT-IN (adds `--once`, writes `kickoff` to stdin then ends, captures `return` from stdout onto record). Both sync+async remote spawns use singleShot. Persistent listen-mode (singleShot:false) = follow-up.
7. CLI wiring: `--swarm` + `--session-id` genuinely required (mode switch → enable swarm plugin + set `swarmSpawned`; session-id drives spawning→running). `--beacon-host/--beacon-port` = config-defaulted overrides (fall through to swarm config). `--working-dir` via spawn(cwd). `--task` dropped → kickoff.
8. CWD roots: beacon-config `spawnRoots`, advertise-and-enforce (MCP-roots style). Default = beacon cwd (or configurable). `Projects/*` expands to concrete immediate-child dirs at load/reload AND periodic re-scan. Advertised == enforced by construction. handleSpawnAgent rejects out-of-whitelist workingDir. Static list; negotiation = follow-up.
9. LLM: `--user` scope always (no root LLM). Child inherits user config cascade from cwd (common case). Fallback = caller lends its active provider into spawn config as a config underlay (reuse DroneConfigInjector/beacon injector), injected at spawn time. Per-spawn `config.llm` selection + provider-scope policy = follow-up.
10. Cross-beacon result relay: reuse `/messages/relay` → `sendBeaconCommand('deliverMessage')` machinery. Beacon B captures `return` → relays spawnResult (callerId/spawnId) through coordinator to beacon A → A `sendToAgent(callerId)`. Same-beacon = direct `sendToAgent`. Caller awaits one-shot spawnResult via pending-result registry in swarm ctx.

## Out of scope (follow-ups)

- Live NDJSON event / SubagentDispatchBlock-style streaming to caller
- Interactive / persistent listen-mode remote dispatch
- Per-spawn `config.llm` provider selection + provider-scope policy
- Dynamic/remote roots negotiation

## Open item verified

- `subagent__dispatch` works under `--output-json --once` (runJsonMode) — no TUI block, subagent stdout piped to dispatch on-data, onProgress flows to NDJSON. Plan still adds a verification test.
