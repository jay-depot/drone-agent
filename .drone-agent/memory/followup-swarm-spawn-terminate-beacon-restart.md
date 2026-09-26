---
key: followup-swarm-spawn-terminate-beacon-restart
tags:
  - followup
  - drone-beacon
  - drone-gateway
  - swarm-console
  - spawn
  - terminate
  - process-lifecycle
created: 2026-09-26T18:33:21.533Z
updated: 2026-09-26T18:33:21.533Z
---

# Follow-up: spawn termination is lost across a beacon restart

**Type:** Deferred follow-up (not part of any current implementation plan). Discovered 2026-09-26 while planning the drone-gateway Swarm Console control surface (roadmap 4.4).

## Problem

`DELETE /api/spawn/:beaconId/:spawnId` kills the agent **process** through the beacon's **in-memory** `activeSpawns` map, keyed by `spawnId`. The call chain is:

coordinator `DELETE /api/spawn/:beaconId/:spawnId` → reverse-channel `terminateSpawn` → beacon `handleTerminateSpawn(spawnId)` → `spawner.terminateAgent(spawnId)` → `sharedTerminateAgent` → `activeSpawns.get(spawnId).process.kill('SIGTERM')`, then `SIGKILL` after 5s.

If the beacon process has restarted since the spawn, `activeSpawns` is empty, `terminateAgent` returns false, and the beacon replies **400**. The spawn *record* still exists with status `running`, but the process can no longer be killed through this path — and nothing reconciles it.

Evidence:
- `drone-swarm-common/src/spawner.ts:231-262` — `sharedTerminateAgent` reads the in-memory `activeSpawns` map.
- `drone-beacon/src/routes/spawn-handlers.ts:123-146` — `handleTerminateSpawn`, 400 guard unless status is `running`/`spawning`.
- `drone-beacon/src/db/init.ts:74-84` — `spawns` table has an `agent_id` column but **no pid**; the spawn object carries `id, agentId, personaId, task, configJson, status, error, createdAt, startedAt, terminatedAt, exitCode`.
- Process handle lives only in memory (`ManagedProcess.process: ChildProcess`, `drone-swarm-common/src/spawner.ts:15-20`), never persisted or exposed.

## Why it matters

- Every client that terminates agents inherits this boundary: the swarm console's `swarm.agent.terminate` (roadmap 4.4) and the coordinator UI's "Terminate" button (which today does not kill processes at all — it only calls `DELETE /api/beacons/:id/sessions/:agentId` + `POST /api/sessions/:id/end`).
- Orphaned agent processes keep running (burning tokens) with a stale `running` spawn record after a beacon restart. There is no startup reconciliation.

## Fix ideas (none chosen yet)

1. **Persist the child PID** in the `spawns` row; on beacon startup, reconcile — either re-adopt/verify the PID or mark unrecoverable rows.
2. **Startup reconciliation sweep:** on beacon boot, mark any spawn row still `running`/`spawning` as `unknown`/`terminated` (they cannot be alive under a fresh beacon process) and surface that state in the UI/CLI.
3. **OS-level ownership:** launch agents in their own process group (or write a pidfile) so a restarted beacon can still signal orphans.
4. **Reverse lookup:** expose terminate-by-`agentId` so callers need not first scan the beacon's spawn list for the `spawnId`.

## Related

- Roadmap 4.4 (drone-gateway Swarm Console control surface) — the planning session that found this.
- Project memory `swarm-console-command-spec` (v1 command spec) — where `swarm.agent.terminate` is specified.
