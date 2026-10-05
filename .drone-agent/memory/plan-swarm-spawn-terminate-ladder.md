---
key: plan-swarm-spawn-terminate-ladder
tags:
  - plan
  - drone-agent
  - drone-beacon
  - drone-swarm-common
  - drone-gateway
  - spawn
  - terminate
  - process-lifecycle
created: 2026-10-05T20:58:36.692Z
updated: 2026-10-05T20:58:36.692Z
---

# Plan: cross-platform agent termination ladder

**Status:** approved design, not yet implemented (2026-10-05).
**Resolves:** follow-up `followup-swarm-spawn-terminate-beacon-restart` (terminate lost across a beacon restart).

## Goal

Terminate a spawned agent reliably, even after a beacon restart. Use a 3-stage ladder. Stage 1 is an in-process exit request over the WebSocket. Stages 2 and 3 are OS signals to a pid found by runtime lookup.

## Verified facts (source)

- The live handle is `activeSpawns: Map<spawnId, ManagedProcess>` (`drone-swarm-common/src/spawner.ts`). Memory only, never persisted.
- The `spawns` table has **no pid column** (`drone-beacon/src/db/init.ts`); `updateSpawnStatus` never writes one.
- `agent_sessions` persists; nothing prunes it on boot (`drone-beacon/src/index.ts` cleanup only expires memories).
- The agent WS **reconnects with backoff** (`drone-agent/src/plugins/swarm/websocket.ts:121`); `/ws` accepts it if `db.getAgent(agentId)` still exists. So after a crash a surviving orphan re-attaches and keeps taking turns.
- `runSwarmListenMode` keeps the process alive awaiting SIGTERM/SIGINT (`drone-agent/src/interactive.ts:442`); on signal `main()` runs `engine.runHooks('onShutdown')` (`drone-agent/src/index.tsx:570`), which runs the swarm cleanup in `plugins/swarm/heartbeat.ts:40` (clear intervals, close WS, flush events, unregister config injector, DELETE session + agent) plus LSP/MCP/terminal cleanup.
- `parseCliArgs` **throws on any unknown `--` flag** (`drone-agent/src/cli.ts:242`). Adding `--spawn-id` to argv REQUIRES a matching parse branch, or every spawned agent dies at boot.

## The ladder

1. **WS `shutdown` command.** The agent exits in-process. `onShutdown` runs. Works on all OS. Reaps the agent's whole child tree (LSP/MCP/terminal/subagents) — a bare SIGKILL leaks them.
2. **`SIGTERM`** to the pid found by argv lookup. Serves two triggers: the fallback when the socket is down, and the timeout escalation when stage 1 did not exit.
3. **`SIGKILL`** to the same pid.

## Agent side

- Add a `shutdown` branch to the WS message chain in `drone-agent/src/plugins/swarm/websocket.ts` (currently a plain if/else-if on `wsMsg.type`).
- The branch calls a new runtime seam `_runtime.requestShutdown()`.
- **Do not self-signal.** A self-`SIGTERM` is `TerminateProcess` on Windows (uncatchable), so `onShutdown` never runs and stage 1 collapses into stage 2. The seam must resolve the listen-mode wait directly so `main()` runs `onShutdown` by the normal path.
- Seam wiring follows the existing `submitUserMessage` / `cancelCurrentRequest` pattern: a host ref (`index.tsx`) read by the `_runtime` capability closure at call time (`runtime/plugin-engine.ts` ~line 945).
- Convert the `runSwarmListenMode` wait into a deferred (resolve on the signal OR on `requestShutdown`).

## Pid lookup

- Add `--spawn-id <spawnId>` to the spawn argv. Put it **early** in the list (before the long `--output-json/--persona/--task` tail) so `ps -o command=` truncation cannot defeat the match.
- `listProcesses()`:
  - Linux: read `/proc/*/cmdline`, split on NUL (exact, no subprocess).
  - macOS/Linux `ps` fallback: `ps -A -o pid=,command=`.
  - If `ps` is missing (busybox/Alpine), return empty and log once. Treat as "enumeration unsupported".
- `findPidBySpawnId(spawnId)`: match the token after `--spawn-id`.
- Re-read argv immediately before signalling (TOCTOU). Treat `ESRCH` as "already gone".
- Single-pid kills only. Negative-pid group kill (`session-end.ts` uses it) is POSIX-only.

## Termination handler

Make `handleTerminateSpawn` (`drone-beacon/src/routes/spawn-handlers.ts`) async. Steps:
1. If the record is already `terminated`, return 400 (unchanged).
2. Run stage 1 using `agent_id` from the row. Wait up to D2 seconds.
3. If the agent is still alive, find the pid by spawn-id. Send SIGTERM. Wait 5 s.
4. If still alive, send SIGKILL.
5. If there is no pid and no socket, return 409 "orphan". Update the row.
6. `activeSpawns` stops being the terminate authority. Keep it only for the in-process concurrency count.

## Data changes

- Write `agent_id` at **spawn time**, not only on `POST /agents` (`drone-beacon/src/routes/agents.ts:29`). Stage 1 needs it; a never-connected orphan has `agent_id = null`.
- Parse `--spawn-id` in `cli.ts`.
- Status value for a lost process — see D1.

## Files to touch

- **drone-agent**: `cli.ts` (parse `--spawn-id`), `interactive.ts` (deferred + seam consumer), `runtime/plugin-engine.ts` (`_runtime.requestShutdown`), `index.tsx` (wire the ref), `plugins/swarm/websocket.ts` (`shutdown` branch).
- **drone-beacon**: `routes/spawn-handlers.ts` (async + ladder), `db/spawns.ts` (status update), route callers need `await`.
- **drone-swarm-common**: `spawner.ts` (add `--spawn-id` early, write `agent_id`), new `process-lookup.ts` / `listProcesses()` — **D3 resolved: lives here**, so the gateway `LocalSpawnBackend` can reuse it.

## Call sites to sweep

- `handleTerminateSpawn` callers: `drone-beacon/src/routes/spawn.ts:34` and `drone-beacon/src/coordinator-ws.ts:179`. Both need `await`.
- The `runSwarmListenMode` wait.

## Open decisions

- **D1.** Status value for a lost process: reuse `failed` + error string (no type churn), or add `orphaned` (honest; touches `types.ts`, coordinator `SpawnStatus`, UI, CLI, and lets `/terminate` accept it).
- **D2.** Stage-1 wait timeout before escalating to SIGTERM.

## Tests

- Unit: `findPidBySpawnId` parse; ladder order against a fake lookup; the `shutdown` branch calls `requestShutdown`; `--spawn-id` parse branch.
- Integration: spawn → restart beacon → terminate → child dies.
