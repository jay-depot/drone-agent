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
  - reconcile
  - liveness
created: 2026-10-05T20:58:36.692Z
updated: 2026-10-05T21:13:32.000Z
---

# Plan: cross-platform agent termination ladder + boot reconcile

**Status:** approved design, not yet implemented (2026-10-05).
**Resolves:** follow-up `followup-swarm-spawn-terminate-beacon-restart` (terminate lost across a beacon restart).

## Goal

Terminate a spawned agent reliably, even after a beacon restart. Use a 3-stage ladder. Stage 1 is an in-process exit request over the WebSocket. Stages 2 and 3 are OS signals to a pid found by runtime lookup. A boot reconcile repairs stale spawn rows using three liveness signals (socket, heartbeat age, pid).

## Verified facts (source)

- The live handle is `activeSpawns: Map<spawnId, ManagedProcess>` (`drone-swarm-common/src/spawner.ts`). Memory only, never persisted.
- The `spawns` table has **no pid column** (`drone-beacon/src/db/init.ts`); `updateSpawnStatus` never writes one.
- `agent_sessions` persists; nothing prunes it on boot (`drone-beacon/src/index.ts` cleanup only expires memories).
- The agent WS **reconnects with backoff** today (`drone-agent/src/plugins/swarm/websocket.ts:121`). The only caller of `connectWebSocket` is `onPluginsLoaded` (`hooks.ts:281`), so the retry budget is one-shot: `maxReconnectAttempts: 5` (`context.ts:106`) with `min(1000·2ⁿ, 30s)` gives ~60 s total, then the socket is dead **forever**. This is the assumption we are changing (see below).
- The HTTP heartbeat is an **independent channel**: `startHeartbeat` (`heartbeat.ts:26`) POSTs `/agents/:id/heartbeat` every 30 s regardless of WS state; `ctx.ws.close()` happens only in `registerShutdown` (`onShutdown`). This bumps `agent_sessions.lastActivity` (`db/agents.ts:39`), which is currently **write-only** — nothing reads it.
- `runSwarmListenMode` keeps the process alive awaiting SIGTERM/SIGINT (`drone-agent/src/interactive.ts:442`); on signal `main()` runs `engine.runHooks('onShutdown')` (`drone-agent/src/index.tsx:570`), which runs the swarm cleanup in `plugins/swarm/heartbeat.ts:40` (clear intervals, close WS, flush events, unregister config injector, DELETE session + agent) plus LSP/MCP/terminal cleanup.
- `handleTerminateSpawn` 400s unless the row status is `running`/`spawning` (`spawn-handlers.ts:131`). A row wrongly marked terminal cannot be killed through this path.
- `parseCliArgs` **throws on any unknown `--` flag** (`drone-agent/src/cli.ts:242`). Adding `--spawn-id` to argv REQUIRES a matching parse branch, or every spawned agent dies at boot.

## Settled design decisions

- **Eternal WS retry (assumption change).** The beacon stays up; if it goes down it comes back. So a live agent is always _eventually_ reachable. Drop `maxReconnectAttempts`; keep `shuttingDown` so an intentional close does not retry. Backoff becomes `min(1000·2ⁿ, 900_000)` (cap 15 min). The ~60 s cliff above no longer exists.
- **Existence and reachability are separate predicates.** Reconcile asks "does the process exist"; the derived read asks "is it reachable". They come apart for a wedged agent (process alive, event loop stuck): `exists=true`, `reachable=false`.
- **The pid only ever ADDS liveness; it never shortens the reconcile wait.** Short-circuiting is a latency optimization, and the sweep runs on the deploy cadence — a grace delay after an update restart is free. Do not pay an enumeration-reliability dependency for it.
- **Grace window: 45 s.** Covers one 30 s heartbeat tick plus jitter. The heartbeat is a flat tick, so a live agent re-announces quickly and the window is heartbeat-bound, not reconnect-bound.
- **Derived `live` field is beacon-local for v1** on `GET /spawn` / `GET /spawn/:id`. No coordinator-UI change yet.
- **D1 (resolved): no new status value.** A verifiably-gone row becomes `terminated` with a note in the nullable `error` field (`error='process lost across beacon restart'`). `failed` implies it never started, so it is wrong. No type churn.
- **The wedge case stays visible and is never auto-killed.** A live pid with no socket and no heartbeat keeps its row and shows unreachable. Killing it remains an explicit ladder action.

## The ladder

1. **WS `shutdown` command.** The agent exits in-process. `onShutdown` runs. Works on all OS. Reaps the agent's whole child tree (LSP/MCP/terminal/subagents) — a bare SIGKILL leaks them.
2. **`SIGTERM`** to the pid found by argv lookup. Serves two triggers: the fallback when the socket is down, and the timeout escalation when stage 1 did not exit.
3. **`SIGKILL`** to the same pid.

Stage 1 is not guaranteed reachable — a wedged or never-reconnected agent needs stages 2/3 — so the ladder is the mechanism, not just a fallback.

## Liveness predicate

```
exists(spawn)    = pidFound(spawn)                       // used by reconcile
reachable(spawn) = isAgentConnected(agentId)
                 || now - lastActivity < HEARTBEAT_GRACE  // 45 s
live(spawn)      = exists || reachable
```

- `isAgentConnected` already exists (`ws-server.ts:55`).
- `lastActivity` already exists and is already bumped by the heartbeat (`db/agents.ts:39`) — this finally gives it a reader.
- Expose `live` as an additive field on `GET /spawn` / `GET /spawn/:id`. Nothing is written. "Orphaned" is a _view_, not a _state_.

## Boot reconcile

New leaf module `drone-beacon/src/spawn-reconcile.ts` (same shape as `fragments-sweep.ts`), wired in `index.ts` after `registerWebSocketServer`.

- Wait `reconnectGraceMs ≈ 45 s` (> one heartbeat tick).
- Sweep `running`/`spawning` rows:
  - **connected OR heartbeat within grace OR pid found** → leave the row (`live: true`).
  - **none of the three** → verifiably gone → `terminated` + `error='process lost across beacon restart'`. This also drops the phantom `agent_sessions` row (one predicate fixes both symptoms).
- The sweep can only **downgrade** rows that fail all three signals. Everything else is left alone.
- Boot-only for v1. (A periodic sweep is possible later but risks racing a slow reconnect; the grace window is what would make it safe.)

## Termination handler

Make `handleTerminateSpawn` (`drone-beacon/src/routes/spawn-handlers.ts`) async. Steps:

1. If the record is already `terminated`, return 400 (unchanged).
2. Run stage 1 using `agent_id` from the row. Wait up to D2 seconds.
3. If the agent is still alive, find the pid by spawn-id. Send SIGTERM. Wait 5 s.
4. If still alive, send SIGKILL.
5. If there is no pid and no socket, return 409 "orphan". Update the row (per D1).
6. `activeSpawns` stops being the terminate authority. Keep it only for the in-process concurrency count.

## Pid lookup

- Add `--spawn-id <spawnId>` to the spawn argv. Put it **early** in the list (before the long `--output-json/--persona/--task` tail) so `ps -o command=` truncation cannot defeat the match.
- `listProcesses()`:
  - Linux: read `/proc/*/cmdline`, split on NUL (exact, no subprocess).
  - macOS/Linux `ps` fallback: `ps -A -o pid=,command=`.
  - If `ps` is missing (busybox/Alpine), return empty and log once. Treat as "enumeration unsupported".
- `findPidBySpawnId(spawnId)`: match the token after `--spawn-id`.
- Re-read argv immediately before signalling (TOCTOU). Treat `ESRCH` as "already gone".
- Single-pid kills only. Negative-pid group kill (`session-end.ts` uses it) is POSIX-only.

## Data changes

- Write `agent_id` at **spawn time**, not only on `POST /agents` (`drone-beacon/src/routes/agents.ts:29`). Stage 1 needs it; a never-connected orphan has `agent_id = null`.
- Parse `--spawn-id` in `drone-agent/src/cli.ts`.
- No new spawn status value (D1).
- Agent: keep `lastActivity` as the heartbeat signal (already written).

## Files to touch

- **drone-agent**: `cli.ts` (parse `--spawn-id`), `interactive.ts` (deferred + seam consumer), `runtime/plugin-engine.ts` (`_runtime.requestShutdown`), `index.tsx` (wire the ref), `plugins/swarm/websocket.ts` (`shutdown` branch + eternal retry, drop the attempt cap), `plugins/swarm/context.ts` (drop `maxReconnectAttempts`).
- **drone-beacon**: `routes/spawn-handlers.ts` (async + ladder), `db/spawns.ts` (status update), new `spawn-reconcile.ts`, `routes/spawn.ts` (expose `live`), route callers need `await`.
- **drone-swarm-common**: `spawner.ts` (add `--spawn-id` early, write `agent_id`), new `process-lookup.ts` / `listProcesses()` — **lives here** (settled), so the gateway `LocalSpawnBackend` can reuse it.

## Call sites to sweep

- `handleTerminateSpawn` callers: `drone-beacon/src/routes/spawn.ts:34` and `drone-beacon/src/coordinator-ws.ts:179`. Both need `await`.
- The `runSwarmListenMode` wait.

## Open decisions

- **D2 (resolved): 5 s.** Stage-1 wait timeout before escalating to SIGTERM. Chosen so bulkier MCP servers get time to exit in-process.

## Tests

- Unit: `findPidBySpawnId` parse; ladder order against a fake lookup; the `shutdown` branch calls `requestShutdown`; `--spawn-id` parse branch; the liveness predicate (three signals, incl. wedge = exists && !reachable); reconcile downgrades only all-three-failed rows.
- Integration: spawn → restart beacon → terminate → child dies. Separately: spawn → restart beacon → child re-announces within grace → row stays.
