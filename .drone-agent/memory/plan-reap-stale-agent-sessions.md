---
key: plan-reap-stale-agent-sessions
tags:
  - plan
  - drone-beacon
  - drone-agent
  - drone-coordinator
  - swarm
  - agent-sessions
  - reaper
  - liveness
  - shutdown
  - bug-fix
created: 2026-11-26T20:38:38.609Z
updated: 2026-11-26T20:45:45.733Z
---

# Plan — Reap stale agent rows and announce abnormal agent exit

**Status**: Ready for execution.
**Branch**: Create `fix/stale-agent-sessions` from `main`. Do all work and memory commits on this branch. Do not commit to `main`.
**Executors**: personas `code` and `test`. One `review` pass at the end.

---

## 1. Summary — what and why

A drone-agent that dies abnormally does not tell its beacon that it is gone.
The process may receive SIGTERM, SIGKILL, or a V8 abort. The agent then runs no
shutdown hook. The agent does not send `DELETE /agents/:id`. The beacon keeps
the agent row.

The beacon has no reaper for the `agent_sessions` table. The row status is
written one time, at insert, as `connected`. No other code writes the status.
Therefore a dead agent looks `connected` for ever.

A live agent is not affected. On the reporting host the beacon had 937 rows,
all `connected`, with about 8 live WebSocket connections. The oldest row was
from 2026-06-30.

The fix has three parts:

- **Part A.** The one-shot agent mode announces its own death on SIGTERM and
  SIGINT.
- **Part B.** The beacon reaps stale agent rows on a timer. This part is the
  structural fix. It works after any death, including SIGKILL.
- **Part C.** The beacon reports agent liveness from the socket map. The
  coordinator clears swarm sessions that are stranded in `processing`.

### Final behaviour

1. `GET /agents` shows `disconnected` for an agent with no open socket. It
   shows `connected` only when the socket is open.
2. A stale agent row is deleted within about 60 s of death.
3. A SIGTERM to a one-shot agent (`--once --output-json`) causes a clean
   shutdown. The agent then deregisters itself.
4. A swarm session stranded in `processing` moves to `ended` after 1 hour. The
   catch-up cron can then retry the ingest.

---

## 2. What the code shows today

Read these facts before you start. They are the reason for each step.

- The only deregistration path is the swarm plugin `onShutdown` hook
  (`drone-agent/src/plugins/swarm/heartbeat.ts:42`, priority 0). It calls
  `DELETE /agents/:id`.
- `onShutdown` runs on the normal return path only
  (`drone-agent/src/index.tsx:592`).
- `runJsonMode` (`drone-agent/src/interactive.ts:100`) installs no signal
  handler. The other three modes do (`:270`, `:545`, `:589`).
- `main()` arms the shutdown watchdog and runs `onShutdown` at
  `drone-agent/src/index.tsx:588`–`:595`, after the mode branch returns.
- `main().catch` calls `process.exit(1)` (`index.tsx`). This skips `onShutdown`.
- The beacon writes `status: 'connected'` at insert
  (`drone-beacon/src/db/agents.ts:12`). Later writes touch `lastActivity` and
  `personaId` only. No code writes another status.
- `GET /agents` returns `db.listAgents()` (`drone-beacon/src/routes/agents.ts:68`).
  This is the table, not the socket map.
- `getConnectedAgents()` (`drone-beacon/src/ws-server.ts:51`) is the in-memory
  socket set. A socket close removes the socket only. The row does not change.
- `isSpawnReachable(agentId, lastActivity, connectedAgentIds, now, graceMs)` and
  `HEARTBEAT_GRACE_MS = 45_000` live in
  `drone-beacon/src/spawn-reconcile.ts`. The boot reconcile already uses them.
- The coordinator runs `markStaleSessions(24h)` every hour
  (`drone-coordinator/src/index.ts:655`). It selects `status = 'active'` only.
  A row in `processing` is never selected.
- `transitionSessionStatus(id, from, to)` stamps `status_changed_at` on a
  status change (`drone-coordinator/src/db/swarm-sessions.ts`).

---

## 3. Decisions (locked with the user)

- **D1 — Scope.** Build A, B, and C.
- **D2 — Reaper action.** Delete the stale row. Do not mark it. Use one shared
  "remove agent" function from the route and the reaper.
- **D3 — Reaper and the coordinator.** The shared removal function also calls
  the coordinator `endSession` and writes the `agent.disconnected` event log.
  It must NOT fire the session-end hook.
- **D4 — Heartbeat safety valve.** `POST /agents/:id/heartbeat` must recreate
  the row when the row is missing (upsert). The heartbeat request carries the
  active persona, so a recreated row is not damaged.
- **D5 — Read surface.** `GET /agents` and `GET /agents/:id` must derive
  `status` from the socket map. The status is `connected` when the socket is
  open, else `disconnected`. Add a derived `live: boolean` field. Do not change
  the stored column. Use the socket only (no heartbeat grace in the read).
- **D6 — One-shot signal handling.** Add SIGTERM and SIGINT handlers to
  `runJsonMode`. The handler body calls `runtime.cancelCurrentRequest?.()`. An
  interrupted turn exits with `process.exitCode = 1`. Do not self-signal. Do
  not add a force-exit timer in the handler.
- **D7 — Shared signal helper.** Extract one `installSignalHandlers` helper.
  Use it in all four run modes. Do not copy the register/remove pair a fourth
  time.
- **D8 — No global safety net.** Do not add `process.on('exit')` or
  `process.on('uncaughtException')`. `process.on('exit')` cannot await the
  deregistration fetch. Part B covers this case.
- **D9 — No config block.** Use module constants. Reuse `HEARTBEAT_GRACE_MS`
  (45 s) for the grace. Add `AGENT_REAP_INTERVAL_MS = 60_000` for the interval.
- **D10 — Coordinator stranded-session reap.** Add
  `markStrandedProcessingSessions(thresholdMs)`. Transition `processing` to
  `ended`. Use a 1 hour threshold. Hardcode the threshold at the call site.
  Reuse `transitionSessionStatus`. Wire it into the existing hourly
  `staleCheckInterval`.
- **D11 — Repair the ADR index.** Fold the `docs/adr/index.md` repair into this
  plan, as its own commit on the same branch. See Step 13.

---

## 4. Order of work and dependencies

- Step 1 (agent signal helper) has the other agent steps as dependents.
- Steps 2 to 6 are beacon work. Step 2 must run before Steps 4 and 5.
- Step 7 is agent work. Step 7 needs Step 3.
- Step 8 is coordinator work.
- Steps 9 to 11 are tests. Step 9 needs Steps 2 to 6. Step 10 needs Step 8.
  Step 11 needs Step 1.
- Step 12 is documentation. It needs the code to be final.
- Step 13 is the ADR index repair. It is docs-only and independent. Do it in
  its own commit.
- Step 14 proves the tests bite.
- Step 15 is the review.
- Step 16 checks the work against the validation criteria.

After each step, run the type check for the changed package. Example:

```bash
pnpm --filter drone-beacon exec tsc --noEmit
```

---

## Step 1 — Add the shared signal helper and use it in every run mode [agent: code]

**File**: `drone-agent/src/interactive.ts`

1. Add this exported helper near the other module functions.

```ts
/**
 * Install one-shot SIGTERM and SIGINT handlers. Return a function that removes
 * them. Each run mode supplies its own signal body.
 */
export function installSignalHandlers(onSignal: () => void): () => void {
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  return () => {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  };
}
```

2. In `runJsonMode`, widen the runtime capability type and add the handler.
   The current code is:

```ts
const runtime = engine.getCapability<{ subagentId?: string }>('runtime');
const subagentId = runtime?.subagentId;

let response: string;
try {
  response = await conversation.sendUserMessage(task, conversationHandler);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  ndjsonHandler({ kind: 'error', message });
  ndjsonHandler({ kind: 'return', result: '', error: message, subagentId });
  process.exitCode = 1;
  return;
}
```

Replace it with:

```ts
const runtime = engine.getCapability<{
  subagentId?: string;
  cancelCurrentRequest?: () => void;
}>('runtime');
const subagentId = runtime?.subagentId;

// A SIGTERM or SIGINT cancels the in-flight turn. The turn then settles as an
// error, so control returns to main(), which runs onShutdown one time.
const removeSignalHandlers = installSignalHandlers(() =>
  runtime?.cancelCurrentRequest?.()
);

let response: string;
try {
  response = await conversation.sendUserMessage(task, conversationHandler);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  ndjsonHandler({ kind: 'error', message });
  ndjsonHandler({ kind: 'return', result: '', error: message, subagentId });
  process.exitCode = 1;
  return;
} finally {
  removeSignalHandlers();
}
```

3. In `runJsonListenMode`, replace the two registrations

```ts
process.once('SIGTERM', onSignal);
process.once('SIGINT', onSignal);
```

with

```ts
const removeSignalHandlers = installSignalHandlers(onSignal);
```

In the `finally` block, replace the guarded `process.removeListener` pair
with `removeSignalHandlers();`.

4. In `runSwarmListenMode`, install the handler inside the promise and remove it
   in the `finally` block:

```ts
let removeSignalHandlers: (() => void) | undefined;
await new Promise<void>(resolve => {
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
  removeSignalHandlers = installSignalHandlers(settle);
  if (shutdownSignal) shutdownSignal.current = settle;
});
```

In the `finally` block, replace the `process.removeListener` pair with
`removeSignalHandlers?.();`.

5. In `runInteractiveLoop`, make the same change as Step 1.3.

**Note**: the existing test `drone-agent/test/json-listen-signal.test.ts` spies
on `process.once` and `process.removeListener`. The helper uses those same
functions. That test must still pass without change.

---

## Step 2 — Add the shared "remove agent" function [agent: code]

**New file**: `drone-beacon/src/agent-removal.ts`

```ts
import * as db from './db/index.js';
import { getCoordinatorClient } from './routes/context.js';
import { logger } from './logger.js';
import type { AgentSession } from './types.js';

export interface RemoveAgentResult {
  /** True when a row was deleted. */
  removed: boolean;
  /** The row as it was before deletion, or undefined when no row existed. */
  agent: AgentSession | undefined;
}

/**
 * Delete one agent row and report the loss.
 *
 * This is the one path that removes an agent. The `DELETE /agents/:id` route
 * and the stale-agent reaper both call it. It reports the end to the
 * coordinator and writes the event log. It does NOT fire the session-end hook:
 * the hook spawns an ingest agent, and the reaper must never cause a spawn
 * storm.
 */
export async function removeAgent(agentId: string): Promise<RemoveAgentResult> {
  const agent = db.getAgent(agentId);
  if (!agent) return { removed: false, agent: undefined };

  const connectedAt = agent.connectedAt;
  const removed = db.unregisterAgent(agentId);
  if (!removed) return { removed: false, agent };

  const client = getCoordinatorClient();
  if (client) {
    client.endSession(agentId, connectedAt).catch(err => {
      logger.warn(`Failed to sync session end to coordinator: ${err}`);
    });
  }

  db.createEventLog({
    eventType: 'agent.disconnected',
    agentId,
    metadata: { connectedAt, durationMs: Date.now() - connectedAt },
  });

  return { removed: true, agent };
}
```

---

## Step 3 — Add the heartbeat upsert and the activity persona [agent: code]

**File**: `drone-beacon/src/db/agents.ts`

1. Change `updateAgentActivity` to accept an optional persona:

```ts
export function updateAgentActivity(
  id: string,
  personaId?: string | null
): AgentSession | undefined {
  const session = getAgent(id);
  if (!session) return undefined;

  const now = Date.now();
  const nextPersona = personaId === undefined ? session.personaId : personaId;

  const stmt = getDatabase().prepare(`
    UPDATE agent_sessions
    SET lastActivity = @lastActivity, personaId = @personaId
    WHERE id = @id
  `);
  stmt.run({ id, lastActivity: now, personaId: nextPersona });

  return { ...session, lastActivity: now, personaId: nextPersona };
}
```

2. Add the upsert function:

```ts
/**
 * Record a heartbeat. Recreate the row when the reaper deleted it. A live
 * agent whose row was reaped reappears within one heartbeat interval.
 */
export function heartbeatAgent(
  id: string,
  personaId: string | null
): AgentSession {
  const updated = updateAgentActivity(id, personaId);
  if (updated) return updated;
  return registerAgent({ id, personaId });
}
```

3. Export `heartbeatAgent` from `drone-beacon/src/db/index.ts`. Add it to the
   agent export block.

---

## Step 4 — Derive liveness and refactor the agent routes [agent: code]

**File**: `drone-beacon/src/routes/agents.ts`

1. Add the imports:

```ts
import { isAgentConnected } from '../ws-server.js';
import { removeAgent } from '../agent-removal.js';
import type { AgentSession } from '../types.js';
```

2. Add the liveness helper at module scope:

```ts
/**
 * Derive liveness at read time. The socket map is the authority for "reachable
 * now". The stored column is left alone; the reaper owns deletion.
 */
function withLiveness(agent: AgentSession): AgentSession & { live: boolean } {
  const live = isAgentConnected(agent.id);
  return { ...agent, status: live ? 'connected' : 'disconnected', live };
}
```

3. Change `GET /agents`:

```ts
app.get('/agents', async () => {
  return db.listAgents().map(withLiveness);
});
```

4. Change `GET /agents/:id` to return the derived view:

```ts
app.get<{ Params: { id: string } }>('/agents/:id', async (request, reply) => {
  const agent = db.getAgent(request.params.id);
  if (!agent) {
    return reply.code(404).send({ error: 'Agent not found' });
  }
  return withLiveness(agent);
});
```

5. Change the heartbeat route to an upsert with a persona:

```ts
app.post<{ Params: { id: string }; Body?: { personaId?: string | null } }>(
  '/agents/:id/heartbeat',
  async request => {
    const personaId = request.body?.personaId ?? null;
    return db.heartbeatAgent(request.params.id, personaId);
  }
);
```

Remove the old 404 branch. The route now always returns 200.

6. Change the `DELETE /agents/:id` route to use the shared function:

```ts
app.delete<{ Params: { id: string } }>(
  '/agents/:id',
  async (request, reply) => {
    const result = await removeAgent(request.params.id);
    if (!result.removed) {
      return reply.code(404).send({ error: 'Agent not found' });
    }
    return { success: true };
  }
);
```

Remove the now-unused `getCoordinatorClient` import if nothing else uses it in
this file.

---

## Step 5 — Add the beacon agent reaper [agent: code]

**New file**: `drone-beacon/src/agent-reaper.ts`

```ts
import * as db from './db/index.js';
import { getConnectedAgents } from './ws-server.js';
import { isSpawnReachable, HEARTBEAT_GRACE_MS } from './spawn-reconcile.js';
import { removeAgent } from './agent-removal.js';
import { logger } from './logger.js';

/** How often the beacon sweeps the agent table. */
export const AGENT_REAP_INTERVAL_MS = 60_000;

/**
 * Delete every agent row that is neither socket-connected nor recently
 * heartbeated. Return the deleted agent ids. The reachability rule is shared
 * with the boot spawn reconcile, so the two views cannot drift.
 */
export async function reapStaleAgents(
  now: number = Date.now(),
  connectedAgentIds: ReadonlySet<string> = new Set(getConnectedAgents()),
  graceMs: number = HEARTBEAT_GRACE_MS
): Promise<string[]> {
  const reaped: string[] = [];
  for (const agent of db.listAgents()) {
    const reachable = isSpawnReachable(
      agent.id,
      agent.lastActivity,
      connectedAgentIds,
      now,
      graceMs
    );
    if (reachable) continue;
    const result = await removeAgent(agent.id);
    if (result.removed) {
      reaped.push(agent.id);
      logger.info(`Reaped stale agent ${agent.id}`);
    }
  }
  return reaped;
}

let reapTimer: NodeJS.Timeout | null = null;

/** Start the periodic reap sweep. Idempotent. */
export function startAgentReaper(
  intervalMs: number = AGENT_REAP_INTERVAL_MS
): NodeJS.Timeout {
  if (reapTimer) return reapTimer;
  reapTimer = setInterval(() => {
    void reapStaleAgents().catch(err => {
      logger.error(err, 'Agent reaper failed');
    });
  }, intervalMs);
  reapTimer.unref?.();
  logger.info(`Agent reaper scheduled every ${intervalMs}ms`);
  return reapTimer;
}

export function stopAgentReaper(): void {
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
}
```

---

## Step 6 — Start and stop the reaper in the beacon [agent: code]

**File**: `drone-beacon/src/index.ts`

1. Add the import next to the `spawn-reconcile` import:

```ts
import { startAgentReaper, stopAgentReaper } from './agent-reaper.js';
```

2. Call `startAgentReaper();` directly after `startSpawnReconcile();`.

3. In the `shutdown` function, call `stopAgentReaper();` next to
   `stopSpawnReconcile();`.

---

## Step 7 — Send the persona with the agent heartbeat [agent: code]

**File**: `drone-agent/src/plugins/swarm/heartbeat.ts`

1. Add the import:

```ts
import type { DroneConfigCapability, DronePersonaCapability } from 'drone-core';
```

2. Change `heartbeat` to send the active persona:

```ts
async function heartbeat(ctx: SwarmContext): Promise<void> {
  try {
    const personaId =
      ctx.registration
        .request<DronePersonaCapability>('persona')
        ?.getActivePersona()?.id ?? null;
    await fetch(`${ctx.baseUrl}/agents/${ctx.sessionId}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personaId }),
    });
  } catch {
    // A heartbeat failure is not fatal. The next tick tries again.
  }
}
```

---

## Step 8 — Reap stranded processing sessions on the coordinator [agent: code]

**File**: `drone-coordinator/src/db/swarm-sessions.ts`

1. Add this function after `markStaleSessions`:

```ts
/**
 * Move sessions stranded in `processing` to `ended`.
 *
 * A processing row is stranded when the ingest hook dies before it marks the
 * session. `ended` returns the session to the catch-up queue, so a failed
 * ingest is retried. The threshold must be well above the hook timeout
 * (300000 ms).
 */
export function markStrandedProcessingSessions(
  thresholdMs: number
): SwarmSession[] {
  const cutoff = Date.now() - thresholdMs;
  const rows = getDatabase()
    .prepare(
      `SELECT * FROM swarm_sessions
       WHERE status = 'processing'
         AND COALESCE(status_changed_at, updatedAt) < ?`
    )
    .all(cutoff) as SwarmSessionRow[];

  const updated: SwarmSession[] = [];
  for (const row of rows) {
    const result = transitionSessionStatus(row.id, 'processing', 'ended');
    if (!('error' in result)) {
      updated.push(result);
    }
  }
  if (updated.length > 0) {
    logger.info(
      `Cleared ${updated.length} stranded processing session(s) to 'ended'`
    );
  }
  return updated;
}
```

2. Export it from `drone-coordinator/src/db/index.ts`. Add it to the
   swarm-sessions export block, next to `markStaleSessions`.

**File**: `drone-coordinator/src/index.ts`

3. Add `markStrandedProcessingSessions` to the import from `./db/index.js`.

4. Change the hourly sweep:

```ts
const staleCheckInterval = setInterval(
  () => {
    markStaleSessions(24 * 60 * 60 * 1000);
    markStrandedProcessingSessions(60 * 60 * 1000);
  },
  60 * 60 * 1000
);
```

---

## Step 9 — Add the beacon tests [agent: test]

**New file**: `drone-beacon/test/agent-reaper.test.ts`

Follow the harness style of `drone-beacon/test/spawn-reconcile.test.ts`. Mock
`../src/logger.js`, `../src/db/index.js`, `../src/ws-server.js`, and
`../src/agent-removal.js`. Keep `isSpawnReachable` real.

Cover these cases:

- A row with no socket and an old `lastActivity` is deleted. `removeAgent`
  receives the id, and the id is in the result.
- A row with an open socket is kept.
- A row with a fresh heartbeat is kept.
- A row exactly at the grace boundary is kept (`graceMs - 1` is stale,
  `graceMs` is kept). Use explicit `now` and `lastActivity` values.
- `startAgentReaper` is idempotent. A second call returns the same timer.
- The reaper timer is `unref`'d. Spy on `setInterval`, capture the handle, and
  assert `unref` was called. Clear the handle.
- `stopAgentReaper` clears the timer.

**File**: `drone-beacon/test/routes.test.ts`

1. Add `isAgentConnected` to the `ws-server` mock. Make it read a mutable set.
   The default set is empty.

2. Change the test `GET /agents lists agents`. The agent has no socket, so the
   response status must now be `disconnected`, and `live` must be `false`.

3. Add a test: with the agent in the socket set, `GET /agents` returns status
   `connected` and `live: true`.

4. Add the same assertions for `GET /agents/:id`.

5. Replace the test `POST /agents/:id/heartbeat returns 404 for missing` with
   `POST /agents/:id/heartbeat recreates a missing row`. Assert status 200 and
   that `GET /agents/:id` then returns the row.

6. Add a test: the heartbeat request body `{ personaId: 'p-1' }` sets the
   persona on a recreated row.

7. Keep the `DELETE /agents/:id` tests (200 and 404).

**File**: `drone-beacon/test/db.test.ts`

1. Add a test: `updateAgentActivity(id, 'p-1')` sets `personaId` to `p-1`.
2. Add a test: `updateAgentActivity(id)` with no persona keeps the stored one.
3. Add a test: `heartbeatAgent` recreates a deleted row with the given persona.

---

## Step 10 — Add the coordinator test [agent: test]

**File**: `drone-coordinator/test/db.test.ts`

Add a `markStrandedProcessingSessions` describe block:

- A session entered into `processing` longer ago than the threshold moves to
  `ended`. The result contains the session.
- A session entered into `processing` just now stays `processing`.
- A session in `active` stays `active`, even when old.
- A `processing` row with `status_changed_at` null falls back to `updatedAt`.

---

## Step 11 — Add the agent signal test [agent: test]

**New file**: `drone-agent/test/json-mode-signal.test.ts`

Follow `drone-agent/test/json-listen-signal.test.ts`. Mock
`node:readline/promises` to yield one kickoff line. Spy on `process.once` and
`process.removeListener`.

Cover these cases:

- `runJsonMode` registers a SIGTERM and a SIGINT handler.
- A SIGTERM during the in-flight turn calls `cancelCurrentRequest`.
- An interrupted turn (the turn promise rejects) resolves with no explicit
  `return` event duplicated, and `process.exitCode` is 1.
- The handlers are removed after the turn, with the exact captured references.

---

## Step 12 — Documentation [agent: code]

1. **New ADR**: `docs/adr/282-stale-agent-reaping-and-abnormal-exit.md`.

   Content:

   - **Context.** Abnormal agent death is unannounced and unreaped. The only
     deregistration path is the graceful `onShutdown` hook. `runJsonMode`
     installs no signal handler. The beacon `agent_sessions` row is written one
     time as `connected` and has no reaper. `GET /agents` reads the table, not
     the socket map. A stranded `processing` swarm session is never cleared.
   - **Decision.** D1 to D10 from section 3 of this plan. State each one.
   - **Consequences.** A dead agent row is deleted within about 60 s. A SIGTERM
     to a one-shot agent now produces a clean shutdown and a deregistration.
     `GET /agents` reports `disconnected` for a dead socket before the row is
     reaped. A failed ingest is retried after 1 hour. The heartbeat is now an
     upsert, so a live agent whose row was reaped reappears within 30 s. A hard
     kill (SIGKILL) is covered by the reaper, not by Part A.
   - **Does not amend** an earlier ADR. It follows ADR 231 (derived liveness,
     boot reconcile) and ADR 264 (shutdown hardening).

2. **Index row**: add a row for 282 at the top of `docs/adr/index.md`. Run the
   duplicate check:

   ```bash
   ls docs/adr | grep -E '^[0-9]{3}-' | sed 's/-.*//' | sort | uniq -d
   ```

   This check is on the ADR files, which have no duplicate numbers. Add the 282
   row in numeric position. Step 13 repairs the index's duplicate and missing
   rows; whichever of the two steps runs second keeps exactly one row per
   number, so the 282 row survives either order.

3. **Fix the false claim**: `docs/agents/hook-ordering.md`. The claim
   "`runJsonMode`'s error path ... All run modes handle SIGTERM and SIGINT the
   same way" is wrong as read today. After Step 1 it becomes true. Change the
   section title to "SIGTERM / SIGINT in every run mode". Name all four modes
   and the shared `installSignalHandlers` helper.

4. **Beacon README**: `drone-beacon/README.md`. Add the reaper and the derived
   `GET /agents` liveness. Note the heartbeat upsert.

5. **Swarm plugin doc**: `docs/agents/swarm-plugin.md`. In the shutdown
   section, note that the heartbeat now carries the active persona.

6. **Obsidian wiki** (vault at `/home/unleet/Obsidian/drone-agent-project`):
   - Add the pointer stub `decisions/282-stale-agent-reaping-and-abnormal-exit.md`.
     Copy the shape of an existing stub, for example
     `decisions/281-wiki-graph-interaction-performance.md`.
   - Add the 282 row to `decisions/index.md`.
   - Add the 282 row to the ADR table in `index.md`.
   - Append an entry to `log.md`, and update `meta.json`.

---

## Step 13 — Repair `docs/adr/index.md` [agent: code]

**File**: `docs/adr/index.md`

This is a docs-only repair. Do it in its own commit, separate from the code
steps. It is folded into this plan because the rot is old and it grows.

**Measured state (2026-11-26).** Re-measure before you change anything. These
numbers are here to show the shape only.

- `docs/adr/` holds **281** numbered files. No file number repeats.
- `index.md` holds **303** rows, covering **276** distinct numbers.
- **27 numbers appear twice**: 171, 172, 176-197, 217, 218, 219.
- **5 files have no row**: 239, 249, 250, 255, 266.
- A YAML frontmatter block sits at lines 14-18 — after the first rows.
- Two table headers exist: `| Page | Summary |` (line 46) and
  `| Page | Description |` (line 85). Prose sits between them.
- The rows are not sorted as one run.

**Rules.**

- Do NOT "fix the count" by adding rows. Dedupe first, then add the 5 missing
  rows.
- Keep the more complete copy of each duplicated row. The two copies differ.
  The older copy is usually longer.
- Verify the **number set**, not only the count. A duplicate row and a missing
  row cancel out in a count.
- Do not use `git stash`.

**Procedure.**

1. Measure first, and record it:

```bash
cd docs/adr
ls | grep -E '^[0-9]{3}-' | sed 's/-.*//' | sort -n | uniq > /tmp/adr-files.txt
grep -oE '^\| \[[0-9]{3}-' index.md | grep -oE '[0-9]{3}' | sort -n | uniq > /tmp/adr-rows.txt
echo "files:" $(wc -l < /tmp/adr-files.txt) " rows:" $(wc -l < /tmp/adr-rows.txt)
echo "files with no row:"; comm -23 /tmp/adr-files.txt /tmp/adr-rows.txt
echo "rows with no file:"; comm -13 /tmp/adr-files.txt /tmp/adr-rows.txt
```

2. Back up the file: `cp docs/adr/index.md /tmp/index.md.bak`.

3. Write a one-off Node script in `/tmp` (not in the repo) that:
   - Reads `index.md`.
   - Extracts the frontmatter block and moves it to the top.
   - Reads every row that matches `^\| \[NNN-`.
   - Groups rows by number. For each duplicated number, keeps the row with the
     longer body (or the first when equal). Logs every choice.
   - Builds the 5 missing rows from their files (read each file, use its H1 as
     the title and its opening summary line as the description).
   - Emits one header row `| Page | Summary |`, one separator, then every row
     sorted newest number first.
   - Writes the result atomically (tmp + rename).

   Rough dedupe shape:

```js
const rows = lines.filter(l => /^\| \[\d{3}-/.test(l));
const byNum = new Map();
for (const row of rows) {
  const n = row.match(/^\| \[(\d{3})-/)[1];
  const prev = byNum.get(n);
  if (!prev || row.length > prev.length) byNum.set(n, row);
}
```

4. Re-measure with the step-1 commands. Require all of these:

```bash
echo "duplicate file numbers (must be empty):"
ls docs/adr | grep -E '^[0-9]{3}-' | sed 's/-.*//' | sort | uniq -d
echo "duplicate row numbers (must be empty):"
grep -oE '^\| \[[0-9]{3}-' docs/adr/index.md | grep -oE '[0-9]{3}' | sort | uniq -d
echo "files:" $(ls docs/adr | grep -cE '^[0-9]{3}-') " rows:" $(grep -cE '^\| \[[0-9]{3}-' docs/adr/index.md)
sed -n '1,4p' docs/adr/index.md
```

- `files with no row` is empty.
- `rows with no file` is empty.
- The file count equals the row count.
- No number repeats.
- The frontmatter is at the top, then the one header.

5. Spot-check 5 rows against their files. The link target must be the real
   filename, and the description must not be truncated.

6. Commit alone:

```bash
git add docs/adr/index.md
git commit -m "docs(adr): repair the ADR index - dedupe 27 rows, add 5 missing, one table"
```

7. Update the tracked followup memory
   `followup-adr-index-duplicate-rows-and-missing-entries`: mark it repaired,
   and record the new counts.

**Note.** The Obsidian vault has its own `decisions/index.md`. Repair it in the
same commit only if it shows the same defect. Measure first. The vault and the
repo index are separate artifacts. The wiki page `docs-adr-index-rot-2026-11-09`
records the earlier measurement of this defect.

---

## Step 14 — Prove the tests bite [agent: test]

The new tests must fail before the code change and pass after it.

1. Back up the changed source files to `/tmp`. **Do not use `git stash`.** On
   this host a `git stash push` with a non-matching pathspec exits 0 and stashes
   nothing. A chained `stash pop` then restores the wrong stash.
2. Restore the pre-change source from `/tmp`. Keep the new test files.
3. Run the new tests. Record the failures. The count must be non-zero.
4. Restore the post-change source. Run the tests again. All must pass.
5. Confirm the restored files match the post-change state.

If a new test passes against the pre-change source, the test does not bite.
Rewrite it.

---

## Step 15 — Review the change [agent: review]

One review pass over the whole branch. Check these points:

- No second copy of the reachability rule. The reaper calls `isSpawnReachable`.
- No second copy of the "remove agent" logic. The route and the reaper call
  `removeAgent`.
- No second copy of the signal register/remove pair. All four modes call
  `installSignalHandlers`.
- `removeAgent` does not fire `runSessionEndHook`.
- The reaper timer is `unref`'d and is stopped on shutdown.
- `GET /agents` does not change the stored column.
- The heartbeat route no longer returns 404.
- Every new function has a test.
- No dead code and no unused imports remain.

---

## Step 16 — Check the work against the validation criteria [agent: test]

Run every command in section 5. Do not mark the work done until all pass.

---

## 5. Validation criteria

All of these must pass.

1. **LSP** — no errors and no warnings on every changed file:
   `drone-agent/src/interactive.ts`,
   `drone-agent/src/plugins/swarm/heartbeat.ts`,
   `drone-agent/test/json-mode-signal.test.ts`,
   `drone-beacon/src/agent-removal.ts`,
   `drone-beacon/src/agent-reaper.ts`,
   `drone-beacon/src/db/agents.ts`,
   `drone-beacon/src/db/index.ts`,
   `drone-beacon/src/routes/agents.ts`,
   `drone-beacon/src/index.ts`,
   `drone-beacon/test/agent-reaper.test.ts`,
   `drone-beacon/test/routes.test.ts`,
   `drone-beacon/test/db.test.ts`,
   `drone-coordinator/src/db/swarm-sessions.ts`,
   `drone-coordinator/src/db/index.ts`,
   `drone-coordinator/src/index.ts`,
   `drone-coordinator/test/db.test.ts`.
2. **Build** — `pnpm -r run build` exits 0.
3. **Typecheck** — `pnpm typecheck` exits 0.
4. **Lint** — `pnpm run lint` exits 0. ESLint runs first, then Prettier. Prettier
   reformats files. Re-read every file before a later edit.
5. **Fast test suite** — `pnpm test` passes.
6. **Regression proof** — Step 14 is complete. The new tests fail before the
   change and pass after it. File backups in `/tmp` prove it. No `git stash`.
7. **Behaviour** (manual or covered by tests):
   - `GET /agents` shows `disconnected` and `live: false` for a row with no
     socket.
   - `GET /agents` shows `connected` and `live: true` for a row with a socket.
   - The reaper deletes a row with no socket and an old heartbeat.
   - The reaper keeps a row with a fresh heartbeat.
   - `POST /agents/:id/heartbeat` recreates a deleted row.
   - A SIGTERM to `runJsonMode` cancels the turn and sets `process.exitCode` 1.
   - A session in `processing` for more than 1 hour moves to `ended`.
   - A session in `processing` for less than 1 hour stays `processing`.
8. **Docs** — ADR 282 exists. The index rows exist. `hook-ordering.md` is
   correct.
9. **Memory committed** — the project memory and any insights are committed on
   `fix/stale-agent-sessions`, not on `main`.

---

## 6. Out of scope

- A global `process.on('exit')` or `process.on('uncaughtException')` net. See D8.
- Reaping `active` swarm sessions. `markStaleSessions` already covers this.
- A config block for the reaper. See D9.
- A repair of the Obsidian vault's own `decisions/index.md` unless it shows the
  same defect (Step 13 measures it first).
- The coordinator UI "Terminate" button, which never kills the process. This is
  a separate path (ADR 231).

---

## 7. Execution summary (2026-11-26, branch `fix/stale-agent-sessions`)

**Status**: COMPLETE. All 16 steps executed. All validation criteria pass.

### Commits

- `5bcdf729` — feat(swarm): steps 1-7 (agent signal helper, beacon removeAgent,
  heartbeat upsert, derived liveness + routes, agent-reaper, reaper wiring,
  heartbeat persona).
- `b59618f8` — test(swarm): beacon agent-reaper.test.ts, routes/db test updates,
  coordinator db.test.ts cases, agent json-mode-signal.test.ts.
- `c23fe470` — docs(swarm): ADR 282 + index row + hook-ordering.md correction +
  beacon README + swarm-plugin.md.
- `317b664e` — docs(adr): repair the ADR index (dedupe 27 rows, add 5 missing,
  one table) — Step 13, own commit.
- `4d09e907` — chore(memory): mark the ADR index followup repaired.
- final commit — Step 15 review fix (`startAgentReaper()` had landed inside the
  shutdown block; moved to after `startSpawnReconcile()`) + lint fix (unused
  `wsServer` import) + prettier-stable ADR index (escaped bare `|` inside code
  spans).

### What was done

Steps 1-11 implemented exactly as written. Step 12 wrote ADR 282, the index row,
corrected the false `hook-ordering.md` SIGTERM claim, the beacon README, and the
swarm-plugin heartbeat/shutdown note, plus the Obsidian vault (pointer stub,
decisions/index.md row, index.md count 281→282, log.md entry, meta.json).
Step 13 repaired `docs/adr/index.md`: 282 files = 282 rows, no duplicate numbers,
no missing rows, frontmatter at top, one header, rows newest-first.
Step 14 proved every new test bites (revert source → 8 beacon + 4 coordinator +
4 agent failures; restore → all pass).
Step 15 review passed every checklist item.

### Review finding (worth recording)

The Step 6 edit placed `startAgentReaper()` INSIDE the `shutdown` function rather
than after `startSpawnReconcile()`. The reaper would never have started. Caught
only by reading the file during the Step 15 review — every test still passed,
because `startAgentReaper` is not imported by any test that exercises `index.ts`.
Fixed.

### Step 13 follow-on (worth recording)

`docs/adr/index.md` was NOT prettier-stable after the repair: the old file was so
mis-formatted that prettier bailed, hiding a latent defect — bare `|` characters
inside inline code spans. Prettier's table writer splits on the first unescaped
`|`, so it mangled those rows. Fixed by escaping the in-cell pipes as `\|` (the
file's existing convention) before running prettier, so the index is now both
correct and formatter-stable.

### Validation (all green)

- LSP: clean (no errors, no warnings on every changed file).
- `pnpm -r run build`: exit 0.
- `pnpm typecheck`: exit 0.
- `pnpm run lint`: exit 0.
- `pnpm test`: 4765 passed, 19 skipped, 0 failed.
- Regression proof: Step 14 complete (file backups in `/tmp`, no `git stash`).
