---
key: planning-seed-async-agent-terminate
tags:
  - seed
  - swarm
  - spawn
  - terminate
  - process-lifecycle
  - async
  - gateway
  - coordinator
  - beacon
  - reconcile
  - eventual-consistency
created: 2026-10-05T22:02:17.080Z
updated: 2026-10-05T22:02:17.080Z
---

# Planning seed: asynchronous agent termination

**Status:** seed only (2026-10-05), not planned. Captured at the end of the
`plan-swarm-spawn-terminate-ladder` work (which made terminate *reliable* but
left it *synchronous*).

**Type:** seed — the shape is agreed-in-spirit; nothing here is implemented, and
several decisions are deliberately open.

---

## The idea

Make `swarm.agent.terminate` (and the terminate API beneath it) **asynchronous**:
the coordinator **accepts** the request and returns immediately; the outcome
**converges** (the spawn row flips to `terminated` once the beacon's ladder
finishes, or reconcile resolves it). i.e. change the meaning from "it is done"
to "it has been accepted and will converge."

## Why this is worth doing

The swarm is already **eventual-consistency-shaped everywhere else**: sessions go
`active → stale → ended`; spawns go `spawning → running → terminated`; a boot
reconcile sweep exists (`drone-beacon/src/spawn-reconcile.ts`); `live` on
`GET /spawn/:id` is a *derived* view, never stored. The synchronous blocking
`DELETE` is the **odd one out** — the single place the system demands "answer me
*now*" over a channel we just spent eight commits making resilient to outage.

### The motivating failure mode (what 1/2 only paper over)

The ladder runs **synchronously inside the reverse-channel RPC**:

```
gateway/console → coordinator DELETE /api/spawn/:beaconId/:spawnId
  → sendBeaconCommand('terminateSpawn', …, timeoutMs)   [reverse channel]
    → beacon handleTerminateSpawn → 3-stage ladder (5s + ps + 5s)
```

If the coordinator's command timeout elapses first, it returns
`503 BEACON_UNAVAILABLE` **while the beacon still completes the kill** — a
**false failure for a successful terminate**; a retry then hits
`400 Cannot terminate: agent status is terminated`. Widening the timeout (done:
`TERMINATE_COMMAND_TIMEOUT_MS = 30000` in `drone-coordinator/src/routes/spawn.ts`)
and bounding `ps` (done: `PS_TIMEOUT_MS = 2000` in
`drone-swarm-common/src/process-lookup.ts`) **move the window; they do not delete
it.** An async `202` is never "failed" — that's the architectural win.

## What it drags in (the reason this is a seed, not a patch)

1. **Beacon protocol split.** `handleTerminateSpawn`
   (`drone-beacon/src/routes/spawn-handlers.ts`) is one `await` today. It becomes
   *validate → dispatch ladder in the background → reply 202-immediately*, plus
   *run ladder → write outcome (`updateSpawnStatus`)*. Introduces an
   **unsupervised background task** where there was none.
2. **Coordinator route.** `DELETE /spawn/:beaconId/:spawnId` needs only a short
   beacon **ack** (accepted), then returns `202` without awaiting the ladder —
   a contract change to the route's meaning.
3. **Client/console UX.** `CoordinatorSpawnBackend.terminateSession`
   (`drone-gateway/src/coordinator-spawn-backend.ts`) currently `await`s, and the
   console handler prints `Terminated "…"` (`drone-gateway/src/console/commands.ts`
   `terminateAgent`). Async makes it "termination **requested**" — **unless** you
   add a poll loop, in which case the wait **moves to the client** rather than
   being removed. Pick one deliberately.
4. **Mid-ladder restart hole.** If the beacon restarts after stage 1 but before
   the row update, the row is stuck `running` and the process may still be alive.
   The current reconcile is **boot-only** (`startSpawnReconcile`, one-shot, 45s
   grace). Async termination realistically wants a **periodic** reconcile, or a
   `terminating` status + retry. **Scope growth.**
5. **It is an ADR.** Redefining `DELETE` from "did it" to "accepted" is exactly
   the kind of decision this project routes through a plan/grill.

## Middle path (worth evaluating first — ~8 lines)

**"4-lite":** in the coordinator terminate route, distinguish **"beacon
connected but the command timed out"** (⇒ return `202 "termination in progress"`;
a connected beacon that accepted *will* finish the ladder) from **"beacon not
connected"** (⇒ keep `503`). Today both collapse into one `503
BEACON_UNAVAILABLE` in `handleCommandError` (`drone-coordinator/src/routes/spawn.ts`).
This kills the false-failure **without** touching the beacon or client contract,
and would let the 30s timeout be reconsidered. Consider as the incremental step
before committing to full async.

## Prerequisite (already landed)

Bounding `ps` was a prerequisite for *any* option here (an unbounded *background*
task is no better than an unbounded *request*, arguably worse). Done in
`4d13d5d3` (`PS_TIMEOUT_MS`). Option 2's timeout widening also landed
(`7630812a`) as the immediate stopgap.

## What exists today (verified 2026-10-05)

- **Gateway console** `swarm.agent.terminate`: resolves `agentId → (beaconId, spawnId)`
  by scanning `listSpawns` across `listBeacons`, then `terminateSpawn(beaconId, spawnId)`
  — `drone-gateway/src/console/commands.ts` (`terminateAgent`, ~L74-105). Prints
  `Terminated "…"` synchronously.
- **Gateway backend** `CoordinatorSpawnBackend.terminateSession`: `await`s
  `coordinatorClient.terminateSpawn(targetBeaconId, session.spawnId)`; warns (does
  not throw) on failure; deletes the local session. `SpawnSession.spawnId` added in
  `7a7742b1`.
- **Gateway client** `CoordinatorClient.terminateSpawn` → `DELETE /api/spawn/:beaconId/:spawnId`
  (`drone-gateway/src/coordinator-client.ts`).
- **Coordinator route** `drone-coordinator/src/routes/spawn.ts`: forwards
  `terminateSpawn` over `sendBeaconCommand` (now 30s), `handleCommandError`
  collapses timeout + not-connected into `503 BEACON_UNAVAILABLE`.
- **Beacon** `handleTerminateSpawn` (`drone-beacon/src/routes/spawn-handlers.ts`):
  the 3-stage ladder (WS `shuwdown` → SIGTERM → SIGKILL); bounded by
  `stage1GraceMs+stage2GraceMs` (5s+5s) + `ps` (2s) + 100ms polling ≈ 12s. Returns
  `200 {success,message}` (graceful / signal-sent / force-killed), `409`
  (enumerate-unavailable / still-connected-but-no-pid / process-gone → marks row
  `terminated`), `400` (not running/spawning), `404` (no spawn).
- **Derived liveness** `getSpawnLiveness` / `live` (`drone-beacon/src/spawn-reconcile.ts`);
  boot-only `startSpawnReconcile`.
- **The other terminate path (NOT this one).** The coordinator UI's "Terminate"
  button uses `DELETE /beacons/:beaconId/sessions/:agentId` + `POST /sessions/:id/end`
  (`drone-coordinator-ui/src/pages/sessions.tsx`) — keyed on `(beaconId, agentId)`,
  touches only the session record, **never kills the process at all**. Any
  unification of terminate semantics must reckon with this second, divergent path.
- **Spawn statuses:** `spawning | running | failed | terminated` (no `terminating`).

## Open questions (for its own session)

- **Semantics:** "accepted" (`202`) vs "done" (`200`)? If accepted, what is the
  **completion signal** downstream — a coordinator event (`spawn.terminated`?), a
  poll on `GET /spawn/:id { live }`, or nothing (fire-and-forget)?
- **Does the client wait?** If the console/backend polls, the wait **moves**, not
  disappears. Which UX (immediate "requested", or bounded poll with a timeout)?
- **Reconcile cadence:** does async force a **periodic** reconcile (vs boot-only)?
  Or a `terminating` status with an in-flight retry + timeout?
- **Mid-ladder restart:** what resolves a row that the ladder abandoned?
- **Beacon protocol:** does `terminateSpawn` get a new "accepted, will converge"
  reply shape, or is 202 synthesized coordinator-side from a fast ack?
- **`4-lite` first?** Land the connected-but-timed-out distinction before the
  full redesign, or go straight to async?
- **UI unification:** should the coordinator-UI button and the console converge
  on one terminate path (and if so, on `spawnId` or a resolve step)?
- **Reporting:** today the ladder distinguishes graceful / SIGTERM / SIGKILL.
  Does the async outcome preserve that (where does it surface)?

## Related

- `plan-swarm-spawn-terminate-ladder` — the plan that made terminate reliable
  (ladder + reconcile + `live` + eternal retry). This seed is its open remainder
  (review finding #1, the async destination).
- `followup-swarm-spawn-terminate-beacon-restart` — resolved by the ladder plan;
  its reconcile is the boot-only sweep this seed may want to make periodic.
- `swarm-console-command-spec` — `swarm.agent.terminate <agentId>` v1 spec (the
  command whose semantics this seed would change).
- `followup-swarm-console-unbacked-commands` — sibling console follow-ups.
- Roadmap 4.4 (Swarm Console) — the control surface that owns the command.
- Concept (beacon/coordinator): the terminate path is a synchronous RPC in an
  otherwise event-driven topology.
