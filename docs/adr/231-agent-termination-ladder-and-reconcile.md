---
tags: [decision, adr, spawn, terminate, process-lifecycle, beacon, coordinator, gateway, agent]
related: [modules/drone-beacon.md, modules/drone-swarm-common.md, modules/drone-gateway.md, modules/drone-coordinator.md, modules/drone-agent.md, concepts/mtls-and-reverse-channel.md, decisions/197-beacon-cwd-roots.md, decisions/198-coordinator-ui-launch-interact.md]
---

# 231 — Cross-platform agent termination ladder + boot reconcile

**Summary**: Terminating a spawned agent no longer depends on the beacon's in-memory process handle. `DELETE /api/spawn/:beaconId/:spawnId` now runs a three-stage ladder (WS in-process shutdown → SIGTERM → SIGKILL) against a pid found by scanning process argv, a boot reconcile repairs spawn rows lost across a beacon restart, liveness is a derived read, and the agent's beacon WebSocket retries forever. Resolves `followup-swarm-spawn-terminate-beacon-restart`.

## Context

`DELETE /api/spawn/:beaconId/:spawnId` killed the agent **process** through the beacon's **in-memory** `activeSpawns` map (`drone-swarm-common/src/spawner.ts`), keyed by `spawnId`. The chain was:

```
coordinator DELETE /api/spawn/:beaconId/:spawnId
  → reverse-channel terminateSpawn
    → beacon handleTerminateSpawn(spawnId)
      → spawner.terminateAgent(spawnId)
        → activeSpawns.get(spawnId).process.kill('SIGTERM')
```

The `spawns` table had **no pid column**; the process handle lived only in memory. If the beacon restarted since the spawn, `activeSpawns` was empty, `terminateAgent` returned false, and the beacon replied **400**. The spawn **record** still said `running`, nothing reconciled it, and the agent process kept running (burning tokens) — with no reaping under a fresh beacon process.

Every client that terminates agents inherited this boundary: the gateway swarm-console's `swarm.agent.terminate` ([223-gateway-swarm-console-control-surface](223-gateway-swarm-console-control-surface.md)) and the coordinator UI's "Terminate" button (which today only ends the session record — `DELETE /beacons/:id/sessions/:agentId` + `POST /sessions/:id/end` — and never kills the process at all).

## Decision

### The terminate ladder (3 stages)

`handleTerminateSpawn` (`drone-beacon/src/routes/spawn-handlers.ts`) became **async** and runs, in order:

1. **WS in-process shutdown.** If the agent's WebSocket is connected, push `{ type: 'shutdown' }`; the agent exits **in-process** (see the seam below) so `onShutdown` runs with no OS signal. This is the only stage that works where SIGTERM is not catchable (Windows) and the only one that reaps the agent's whole child tree (LSP/MCP/terminal/subagents).
2. **SIGTERM** to the pid found by argv lookup, then wait out the grace.
3. **SIGKILL** to the same pid.

Stage 2 serves two triggers: the fallback when the socket is down, and the timeout escalation when stage 1 does not exit.

**A pid is only ever signalled when enumeration *positively found it*.** When enumeration is unavailable (`unavailable`) and the agent is unreachable, the handler returns **409** rather than risk signalling the wrong process. When the pid is `absent` and the agent is not connected, the row is marked `terminated` with `error = 'process lost across beacon restart'` and 409 is returned.

Grace defaults: `stage1GraceMs = 5000`, `stage2GraceMs = 5000`, `pollIntervalMs = 100`. The 5 s stage-1 wait is deliberate — bulkier MCP servers need time to exit in-process.

### Spawn id in argv (the fingerprint)

The spawner front-loads `--spawn-id <spawnId>` into the child argv, **early** (right after `--swarm`, before the long `--output-json/--persona/--task` tail) so column truncation cannot defeat the match. The id survives a beacon restart because it lives in the kernel's copy of the child's argv, not in beacon memory. `drone-agent/src/cli.ts` gained a matching `--spawn-id` parse branch (`CliOptions.spawnId`) — **required**, because `parseCliArgs` throws on any unknown `--` flag.

The `agent_id` is also written **at spawn time** (not only when the agent later calls `POST /agents`), so stage 1 has an agentId for a spawn that never connected; `SpawnDb.createSpawn` gained an optional `agentId` parameter threaded through the beacon adapter and `db.createSpawn`.

### `process-lookup.ts` — a three-state, bounded lookup

New `drone-swarm-common/src/process-lookup.ts`:

- `parsePsOutput` / `matchPidBySpawnId` (pure) and `listProcesses` / `findPidBySpawnId` (async).
- Enumeration is a single unified `ps -A -ww -o pid=,command=` (procps and BSD both honor `-ww`, which disables command-column truncation), tokenized on whitespace — the same shape on Linux and macOS.
- **Three-state result**: `{ status: 'found', pid } | { status: 'absent' } | { status: 'unavailable' }`. `listProcesses()` returns `ProcessInfo[] | null` where `null` = "enumeration could not run". A caller must **never** treat `unavailable` as `absent` — "could not look" is not "nothing found".
- **Bounded**: the `ps` call carries `PS_TIMEOUT_MS = 2000` (an execFile timeout). Process enumeration runs inside the terminate ladder (and the liveness read), so an unbounded `ps` would make those operations unbounded too. A timeout throws and degrades to `unavailable` (never `absent`).

### In-process shutdown seam (agent side)

`runSwarmListenMode` (`drone-agent/src/interactive.ts`) keeps the process alive on a deferred that resolves on **either** an OS signal (SIGTERM/SIGINT) **or** `_runtime.requestShutdown()`. The swarm plugin's WS `onmessage` gained a `shutdown` branch that calls `requestShutdown()`, which resolves the deferred so `main()` runs `engine.runHooks('onShutdown')` by the normal path. **Do not self-signal**: a self-`SIGTERM` is `TerminateProcess` on Windows (uncatchable), so `onShutdown` would never run and stage 1 would collapse into stage 2. Signal listeners are removed and the seam cleared on exit.

The seam is wired like the existing `submitUserMessage`/`cancelCurrentRequest` options: `CreateDronePluginEngineOptions.onRequestShutdown` → the `_runtime` capability's `requestShutdown` → a host ref (`shutdownSignalRef` in `index.tsx`) read at call time.

### Boot reconcile + derived liveness

New `drone-beacon/src/spawn-reconcile.ts`:

- **Reachability** — `isSpawnReachable(agentId, lastActivity, connectedAgentIds, now, grace)` is true when the agent's socket is open **or** it heartbeated within `HEARTBEAT_GRACE_MS = 45_000` (one 30 s heartbeat tick + jitter). It is deliberately **independent** of the pid check: a wedged process is `exists && !reachable`.
- **Liveness** — `getSpawnLiveness(spawns)` derives `{ exists, reachable, live = exists || reachable }` from one enumeration; `handleGetSpawn` is now async and exposes the derived `live` field on `GET /spawn/:id`. **Nothing is written** — "orphaned" is a *view*, not a *state*.
- **Reconcile** — `reconcileSpawnRows` downgrades a `running`/`spawning` row to `terminated` (+ the `process lost across beacon restart` note) **only** when it is neither reachable nor has a live pid, and drops the phantom `agent_sessions` row. A row that fails only one signal is left alone. **Enumeration failure never downgrades a row.**
- Scheduled boot-only via `startSpawnReconcile` (`RECONCILE_GRACE_MS = 45_000`, one-shot, `unref`'d) wired in `index.ts` after `registerWebSocketServer`, with `stopSpawnReconcile` on shutdown. Boot-only because the grace window is what makes it safe against a slow reconnect.

### Eternal WS retry (assumption change)

The agent's beacon WebSocket now **retries forever** with backoff capped at 15 minutes (dropped `maxReconnectAttempts`; kept `ctx.shuttingDown` so an intentional close does not retry). This is a deliberate assumption change: the beacon stays up, and if it goes down it comes back, so a live agent is always *eventually* reachable. The previous budget (`maxReconnectAttempts: 5`, ~60 s total) was **one-shot** — `connectWebSocket`'s only caller is `onPluginsLoaded` — so any beacon outage longer than a minute stranded the agent's socket permanently. Because the HTTP heartbeat is an independent channel that never stops while the process lives, a live agent also re-announces itself within ~30 s of the beacon returning.

### En-route corrections

- **Gateway `terminateSession` targeted the wrong id** (`7a7742b1`). `CoordinatorSpawnBackend.spawnSession` stored `processId = agentId || spawnId`, and `terminateSession` passed `processId` into the terminate endpoint's **spawnId** slot, so `DELETE /api/spawn/<beacon>/<agentId>` 404'd at the beacon and the ladder never ran — a silent no-op (the warning was swallowed and the local session deleted). Fix: `SpawnSession` gained an optional `spawnId` (set from `spawnResult.spawnId`); `processId` stays the agentId (used by `sendMessage`); `terminateSession` calls `terminateSpawn(targetBeaconId, spawnId)` and warns + skips when no spawnId was recorded, instead of sending a wrong id. *(The console handler already resolved correctly; this was a distinct path.)*
- **Coordinator terminate timeout widened to 30 s** (`7630812a`). The ladder runs **synchronously inside the reverse-channel RPC**, bounded at ~5 s + 2 s (`ps`) + 5 s + polling ≈ 12 s, against `sendBeaconCommand`'s 15 s default (`drone-coordinator/src/beacon-ws.ts`). Too little headroom: a slow host could time the command out while the beacon still completed the kill, returning `503 BEACON_UNAVAILABLE` **for a successful terminate**, after which a retry hits `400 ... status is terminated`. New `TERMINATE_COMMAND_TIMEOUT_MS = 30000` at the route (`drone-coordinator/src/routes/spawn.ts`); other commands keep the 15 s default.
- **CodeQL `js/polynomial-redos` on the ps parser** (`b702ab1e`). The parse regex `/^\s*(\d+)\s+(.+)$/` overlaps: `\s` ⊆ `.`, so the separator `\s+` and the unanchored tail `.+` can split a run of spaces ambiguously (witness: `"9 "` + many spaces). Fixed for free by anchoring the command's first char to non-whitespace (`/^\s*(\d+)\s+(\S.*)$/`), which removes the overlap; `ps` pads the column and `argv[0]` is never whitespace-led, so real output is unchanged (the one delta — a pid-only line is now skipped instead of yielding an empty argv — is more correct). No suppression comment: the project reserves `// codeql[...]` for genuine dismissals (cf. `7ea4582f` for the same rule on `persona-metadata.ts`, [228-persona-metadata-derivation](228-persona-metadata-derivation.md)).

## Consequences

- Terminate works after a beacon restart. The old in-memory handle is no longer the authority: `activeSpawns` is kept only for the in-process concurrency count, and the two accessors that handed out a live `ChildProcess` (`getManagedProcess`/`getActiveSpawns` through the beacon) were removed as dead code (`3b76911e`); `terminateAgent` is retained as a library entry point.
- Liveness is derived, never stored. The boot reconcile only ever **downgrades** rows that fail all three signals.
- The known **remaining** gap is that terminate is still **synchronous**: even with the 30 s timeout and the bounded `ps`, a slow-enough ladder can still produce a false `503` for a successful kill — the timeout moves the window, it does not delete it. The async redesign (accept + converge) is captured as the seed `planning-seed-async-agent-terminate`.
- The coordinator UI's "Terminate" button remains a **separate, divergent path** keyed on `(beaconId, agentId)` that never kills the process; unifying the two terminate semantics is open.

## Verification

Ladder + reconcile tests green; full fast suite **3513 passed / 14 skipped**. New/extended suites: `drone-swarm-common/test/process-lookup.test.ts` (12), `drone-beacon/test/spawn-reconcile.test.ts` (11), `drone-beacon/test/spawn-handlers.test.ts` ladder cases, gateway `coordinator-spawn-backend.test.ts` (spawnId capture + terminate target + no-spawnId guard), coordinator `routes/spawn.test.ts` (30 s assertion). `pnpm -r run build` and `pnpm lint` clean.

## Source

Plan `plan-swarm-spawn-terminate-ladder` (completed; **deleted from project memory after this ingest**) — commits `88ccb4fa`, `dc75b6e2`, `cc767f51`, `71ea4023`, `3d3e803f`, `3ba04461`, `bd0d1c0a`, `cbe65c23`, `3b76911e`, `0b16e51a`, `e1f214bb`, `26761ec8`, `e2d9bd0c`, `7a7742b1`, `4d13d5d3`, `7630812a`, `6f673ff6`, `b702ab1e` on `feat/gateway-swarm-console`. Review follow-ups: gateway spawnId fix (`7a7742b1`), coordinator timeout (`7630812a`), CodeQL regex (`b702ab1e`).

## Related

- [drone-beacon](../../drone-beacon/) — the ladder, reconcile, and spawn handlers
- [drone-swarm-common](../../drone-swarm-common/) — `process-lookup.ts`, the spawner
- [drone-agent](../../drone-agent/) — the in-process shutdown seam
- [drone-gateway](../../drone-gateway/) — `terminateSession` spawnId fix
- [drone-coordinator](../../drone-coordinator/) — the terminate command timeout
- mtls-and-reverse-channel — the reverse channel the terminate command rides
- [197-beacon-cwd-roots](197-beacon-cwd-roots.md) — the other spawn-time beacon concern (working-dir whitelisting)
- [198-coordinator-ui-launch-interact](198-coordinator-ui-launch-interact.md) — the spawn lifecycle this terminate closes
- [223-gateway-swarm-console-control-surface](223-gateway-swarm-console-control-surface.md) — `swarm.agent.terminate`
- [224-gateway-spawn-targeting](224-gateway-spawn-targeting.md) — the session's recorded beacon
