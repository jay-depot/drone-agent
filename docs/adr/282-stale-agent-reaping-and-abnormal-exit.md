---
tags:
  [decision, adr, beacon, agent, coordinator, swarm, agent-sessions, shutdown]
related:
  [231-agent-termination-ladder-and-reconcile.md, 264-shutdown-hardening.md]
---

# 282 — Stale agent reaping and abnormal-exit announcement

**Summary**: An agent that dies abnormally leaves a `connected` row in the
beacon `agent_sessions` table for ever. The one-shot `--once --output-json` mode
registered no signal handler, so a SIGTERM or SIGINT skipped deregistration. The
beacon had no reaper, `GET /agents` read the table instead of the socket map,
and a swarm session stranded in `processing` was never cleared. This ADR fixes
all three: the agent announces its own death on signal, the beacon reaps stale
rows on a timer, and the coordinator returns a stranded session to the catch-up
queue.

**Status**: Accepted (2026-11-26, branch `fix/stale-agent-sessions`)

## Context

A drone-agent that dies abnormally does not tell its beacon that it is gone. The
process may receive SIGTERM, SIGKILL, or a V8 abort. The agent then runs no
shutdown hook and sends no `DELETE /agents/:id`.

The only deregistration path was the swarm plugin `onShutdown` hook
(`drone-agent/src/plugins/swarm/heartbeat.ts`, priority 0). That hook runs on
the normal return path only. `runJsonMode`
(`drone-agent/src/interactive.ts`) installed no signal handler, while the other
three run modes did.

The beacon had no reaper for `agent_sessions`. The row status is written one
time, at insert, as `connected`. No later code writes another status. A dead
agent therefore looks `connected` for ever. On the reporting host the beacon had
937 rows, all `connected`, with about 8 live WebSocket connections, and the
oldest row was months old.

`GET /agents` returned `db.listAgents()`, the table, not the in-memory socket
map. `getConnectedAgents()` is the socket set; a socket close removes the socket
only and leaves the row alone.

The coordinator ran `markStaleSessions(24h)` every hour. It selects
`status = 'active'` only. A row in `processing` whose ingest hook died before it
marked the session was never selected, so the catch-up queue never retried the
ingest.

## Decision

- **D1 — Scope.** Build the agent signal path, the beacon reaper, and the
  coordinator stranded-session reap.
- **D2 — Reaper action.** Delete the stale row. Do not mark it. Use one shared
  "remove agent" function from the route and the reaper
  (`drone-beacon/src/agent-removal.ts`).
- **D3 — Reaper and the coordinator.** The shared removal function also calls
  the coordinator `endSession` and writes the `agent.disconnected` event log. It
  must NOT fire the session-end hook: that hook spawns an ingest agent, and the
  reaper must never cause a spawn storm.
- **D4 — Heartbeat safety valve.** `POST /agents/:id/heartbeat` recreates the
  row when the row is missing (upsert). The heartbeat request carries the active
  persona, so a recreated row is not damaged.
- **D5 — Read surface.** `GET /agents` and `GET /agents/:id` derive `status`
  from the socket map: `connected` when the socket is open, else `disconnected`.
  They add a derived `live: boolean` field. The stored column is unchanged. The
  read uses the socket only, with no heartbeat grace.
- **D6 — One-shot signal handling.** `runJsonMode` gains SIGTERM and SIGINT
  handlers. The handler body calls `runtime.cancelCurrentRequest?.()`. An
  interrupted turn exits with `process.exitCode = 1`. The handler does not
  self-signal and adds no force-exit timer.
- **D7 — Shared signal helper.** One `installSignalHandlers` helper serves all
  four run modes, instead of a fourth copy of the register/remove pair.
- **D8 — No global safety net.** No `process.on('exit')` and no
  `process.on('uncaughtException')`. `process.on('exit')` cannot await the
  deregistration fetch; the reaper covers this case.
- **D9 — No config block.** Use module constants. Reuse `HEARTBEAT_GRACE_MS`
  (45 s) for the grace and add `AGENT_REAP_INTERVAL_MS = 60_000` for the
  interval.
- **D10 — Coordinator stranded-session reap.** Add
  `markStrandedProcessingSessions(thresholdMs)`. It transitions `processing` to
  `ended`, reusing `transitionSessionStatus`, and is wired into the existing
  hourly sweep with a hardcoded 1 hour threshold.

## Consequences

- A stale agent row is deleted within about 60 s of death. The reachability rule
  is shared with the boot spawn reconcile (`isSpawnReachable`), so the two views
  cannot drift.
- A SIGTERM to a one-shot agent now produces a clean shutdown and a
  deregistration.
- `GET /agents` reports `disconnected` for a dead socket before the row is
  reaped, and `connected` only when the socket is open.
- The heartbeat is now an upsert, so a live agent whose row was reaped
  reappears within one heartbeat interval (30 s).
- A failed ingest is retried: a session stranded in `processing` moves to
  `ended` after 1 hour, which returns it to the catch-up queue.
- A hard kill (SIGKILL) is covered by the reaper, not by the signal path.

## Does not amend an earlier ADR

This decision follows ADR 231 (derived liveness, boot reconcile) and ADR 264
(shutdown hardening). It closes the SIGKILL case that ADR 264 could not cover
with any signal handler.
