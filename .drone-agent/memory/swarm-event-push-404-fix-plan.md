---
key: swarm-event-push-404-fix-plan
tags: []
created: 2026-06-30T05:46:11.704Z
updated: 2026-06-30T05:49:25.745Z
---

# Plan: Fix Conversation Event Push 404 and Add Swarm Session Cleanup

## What & Why

The drone-agent swarm plugin sends conversation events and session registrations to the beacon, but the beacon is missing proxy routes for these endpoints. This causes `404` errors and lost events. Additionally, swarm sessions are never cleaned up on shutdown. This plan adds the missing beacon proxy routes, adds a swarm session end endpoint on the coordinator, and wires up cleanup on agent shutdown.

## Step-by-Step Implementation

### Step 1: Add `POST /sync/events/push` route to the beacon

**File:** `drone-beacon/src/routes/sync.ts`

Add a new route that accepts the same body shape as the coordinator's endpoint and proxies via `coordinatorClient.pushEvents()`.

```typescript
app.post<{
  Body: {
    events: Array<{
      id: string;
      sessionId: string;
      correlationId?: string;
      type: string;
      payload?: string;
      metadata?: string;
      createdAt: number;
    }>;
  };
}>('/sync/events/push', async (request, reply) => {
  const { events } = request.body;
  if (!events || !Array.isArray(events) || events.length === 0) {
    return reply.code(400).send({ error: 'events array is required' });
  }
  const client = getCoordinatorClient();
  if (client) {
    client.pushEvents(events).catch(err => {
      logger.warn(`Failed to proxy events to coordinator: ${err}`);
    });
  }
  return reply.code(201).send({ count: events.length });
});
```

**Dependencies:** None (standalone route addition)

---

### Step 2: Add `POST /sync/sessions/register` route to the beacon

**File:** `drone-beacon/src/routes/sync.ts`

Add a route that accepts session registration and proxies to the coordinator.

```typescript
app.post<{
  Body: { id: string; personaId?: string; beaconId: string };
}>('/sync/sessions/register', async (request, reply) => {
  const { id, personaId, beaconId } = request.body;
  if (!id || !beaconId) {
    return reply.code(400).send({ error: 'id and beaconId are required' });
  }
  const client = getCoordinatorClient();
  if (client) {
    client.registerSwarmSession(id, personaId ?? null).catch(err => {
      logger.warn(
        `Failed to proxy session registration to coordinator: ${err}`
      );
    });
  }
  return reply.code(201).send({ id, status: 'active' });
});
```

**Dependencies:** None (standalone route addition)

---

### Step 3: Add `endSwarmSession()` method to beacon's `CoordinatorClient` interface and implementation

**File:** `drone-beacon/src/coordinator-client.ts`

**3a.** Add to the `CoordinatorClient` interface (around line 55):

```typescript
endSwarmSession(sessionId: string): Promise<void>;
```

**3b.** Add to the implementation object (after `pushEvents`, around line 569):

```typescript
async endSwarmSession(sessionId: string): Promise<void> {
  try {
    const res = await cfetch(`${baseUrl}/sync/sessions/${sessionId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      logger.warn(`Failed to end swarm session: ${res.status}`);
    } else {
      logger.info(`Ended swarm session ${sessionId}`);
    }
  } catch (err) {
    logger.warn(`Failed to end swarm session: ${err}`);
  }
},
```

**Dependencies:** Step 4 (the coordinator endpoint must exist first)

---

### Step 4: Add `DELETE /sync/sessions/:id` endpoint to the coordinator

**File:** `drone-coordinator/src/routes/swarm.ts`

Add a route that marks a swarm session as ended:

```typescript
app.delete<{ Params: { id: string } }>(
  '/sync/sessions/:id',
  async (request, reply) => {
    const session = db.updateSwarmSessionStatus(request.params.id, 'ended');
    if (!session) {
      return reply.code(404).send({ error: 'Swarm session not found' });
    }
    return session;
  }
);
```

**Dependencies:** None (standalone route addition, uses existing `updateSwarmSessionStatus`)

---

### Step 5: Add `DELETE /sync/sessions/:id` proxy route to the beacon

**File:** `drone-beacon/src/routes/sync.ts`

Add a route that proxies session end to the coordinator:

```typescript
app.delete<{ Params: { id: string } }>(
  '/sync/sessions/:id',
  async (request, reply) => {
    const client = getCoordinatorClient();
    if (!client) {
      return reply.code(502).send({ error: 'Coordinator not configured' });
    }
    await client.endSwarmSession(request.params.id);
    return { success: true };
  }
);
```

**Dependencies:** Step 3 (the `endSwarmSession` method must exist on the client)

---

### Step 6: Wire up swarm session cleanup in the swarm plugin's `onShutdown` hook

**File:** `drone-agent/src/plugins/swarm/index.ts`

In the `onShutdown` hook (around line 952), add a call to end the swarm session after flushing events and before the agent cleanup:

```typescript
registration.hooks.onShutdown(async () => {
  shuttingDown = true;
  clearInterval(heartbeatInterval);
  if (ws) ws.close();
  await flushEventBuffer();
  if (beaconConfigInjector && configCap) {
    configCap.unregisterInjector(beaconConfigInjector.id);
  }
  // End swarm session on coordinator
  try {
    await fetch(`${baseUrl}/sync/sessions/${sessionId}`, {
      method: 'DELETE',
    });
  } catch {
    // Silently ignore cleanup failures
  }
  try {
    await fetch(`${baseUrl}/agents/${sessionId}`, {
      method: 'DELETE',
    });
  } catch {
    // Silently ignore cleanup failures
  }
});
```

**Dependencies:** Step 5 (the beacon proxy route must exist)

---

### Step 7: Verify and test

1. **TypeScript compilation**: Run `pnpm build` in the monorepo root — all packages must compile without errors.
2. **Lint**: Run `pnpm lint` — no new lint errors.
3. **Tests**: Run `pnpm test` — existing tests must still pass.
4. **Manual verification**: Start the coordinator, beacon, and an agent with swarm enabled. Verify:
   - No `[swarm] Failed to push N events: 404` messages appear
   - Session registration succeeds without errors
   - On agent shutdown, the swarm session status is updated to `ended` on the coordinator

---

### Validation Criteria

- [x] `pnpm build` passes with no errors
- [x] `pnpm lint` passes with no new errors
- [x] `pnpm test` passes (all existing tests)
- [x] LSP diagnostics are clean across all modified files
- [ ] The `[swarm] Failed to push N events: 404` message no longer appears during normal operation
- [ ] Swarm sessions are marked as `ended` on the coordinator when the agent shuts down

---

## Implementation Summary (completed 2026-06-30)

All 6 implementation steps completed. Changes across 4 files:

1. **`drone-beacon/src/routes/sync.ts`** — Rewrote with 3 new routes: `POST /sync/events/push`, `POST /sync/sessions/register`, `DELETE /sync/sessions/:id`
2. **`drone-beacon/src/coordinator-client.ts`** — Added `endSwarmSession()` to both the `CoordinatorClient` interface and the implementation object
3. **`drone-coordinator/src/routes/swarm.ts`** — Added `DELETE /sync/sessions/:id` endpoint that marks sessions as `ended`
4. **`drone-agent/src/plugins/swarm/index.ts`** — Added swarm session cleanup call in `onShutdown` hook

Build, lint, and all 808 tests pass. Commit: `0ae961a`
