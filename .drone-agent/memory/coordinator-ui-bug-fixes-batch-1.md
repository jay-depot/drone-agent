---
key: coordinator-ui-bug-fixes-batch-1
tags:
  - plan
  - coordinator-ui
  - bug-fix
created: 2026-07-28T17:07:16.164Z
updated: 2026-07-28T17:07:16.164Z
---

# Plan: Coordinator UI Bug Fixes (Batch 1)

## Summary

Three bugs in the coordinator UI related to session lifecycle and display:

1. **Terminate button doesn't work for already-ended sessions** — The terminate flow only updates the `beacon_sessions` table, but the UI reads from `swarm_sessions`. When the beacon session is already ended, the DELETE returns 404 and the swarm session status never changes.
2. **Session peek auto-scrolls to wrong place** — Events are rendered newest-first (reversed) but auto-scroll goes to the bottom (oldest), so new events arriving scroll the user away from them.
3. **Pagination on sessions page is broken** — The `/sessions` endpoint returns `count = sessions.length` (the number returned, not the total), so `hasMore` is always false and the Next button never activates.

## Steps

### Step 1: Add `POST /sessions/:id/end` endpoint (coordinator backend)

**File**: `drone-coordinator/src/routes/swarm.ts`

Add a new route handler after the existing `/sessions/:id/processed` route:

```typescript
app.post<{ Params: { id: string } }>(
  '/sessions/:id/end',
  async (request, reply) => {
    const session = db.getSwarmSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    // Allow ending from any status
    const result = db.updateSwarmSessionStatus(request.params.id, 'ended');
    return reply.send(result);
  }
);
```

This uses the existing `updateSwarmSessionStatus()` function in `swarm-sessions.ts` — no new DB function needed.

**File**: `drone-coordinator/src/db/index.ts`

Add `updateSwarmSessionStatus` to the exports (check if it's already exported — it should be, since `updateSwarmSessionStatus` is used by the sync DELETE handler).

**Dependencies**: None.

### Step 2: Update terminate flow in sessions UI page

**File**: `drone-coordinator-ui/src/pages/sessions.tsx`

In the `handleDialogConfirm` function, change the `terminate` case to:

1. Call the beacon DELETE endpoint (existing behavior)
2. If it fails (404 or any error), that's fine — the beacon session is already ended
3. Then call `POST /sessions/:id/end` to update the swarm session status
4. Refresh the list

```typescript
if (dialogAction === 'terminate') {
  // Try to end the beacon session (may already be ended)
  const beaconRes = await authFetch(
    `/beacons/${dialogSession.beaconId}/sessions/${dialogSession.agentId}`,
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        disconnectedAt: Date.now(),
        durationMs: Date.now() - dialogSession.connectedAt,
      }),
    }
  );
  // Whether beacon session was ended now or already ended, update swarm session
  await authFetch(`/sessions/${dialogSession.id}/end`, {
    method: 'POST',
  });
}
```

**Dependencies**: Step 1 (the endpoint must exist).

### Step 3: Fix event ordering and auto-scroll in session detail

**File**: `drone-coordinator-ui/src/pages/session-detail.tsx`

Two changes:

1. **Remove the reverse rendering**: Change `{[...events].reverse().map(event => {` to `{events.map(event => {` — events are already stored in chronological order (the REST endpoint returns them `ORDER BY createdAt ASC`).

2. **Keep the auto-scroll**: The `useEffect` that calls `eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' })` already scrolls to the bottom. With chronological rendering, the bottom will now show the newest events, which is the correct behavior.

**Dependencies**: None.

### Step 4: Add `countSwarmSessions()` to the database layer

**File**: `drone-coordinator/src/db/swarm-sessions.ts`

Add a new function that returns the total count of swarm sessions (with optional status filter):

```typescript
export function countSwarmSessions(options?: {
  status?: string;
}): number {
  let query = 'SELECT COUNT(*) as count FROM swarm_sessions WHERE 1=1';
  const params: unknown[] = [];

  if (options?.status) {
    query += ' AND status = ?';
    params.push(options.status);
  }

  const stmt = getDatabase().prepare(query);
  const row = stmt.get(...params) as { count: number };
  return row.count;
}
```

**File**: `drone-coordinator/src/db/index.ts`

Export `countSwarmSessions` from the barrel file.

**Dependencies**: None.

### Step 5: Update `/sessions` route to return actual total count

**File**: `drone-coordinator/src/routes/swarm.ts`

In the `GET /sessions` handler, change the response to use the actual total count:

```typescript
app.get<{
  Querystring: {
    status?: string;
    sortBy?: 'createdAt' | 'updatedAt';
    sortDirection?: 'ASC' | 'DESC';
    limit?: string;
    offset?: string;
  };
}>('/sessions', async (request, reply) => {
  const { status, sortBy, sortDirection, limit, offset } = request.query;
  const sessions = db.listSwarmSessions({
    status,
    sortBy,
    sortDirection,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  const totalCount = db.countSwarmSessions({ status });
  return reply.send({ sessions, count: totalCount });
});
```

**Dependencies**: Step 4.

### Step 6: Add tests

**File**: `drone-coordinator/test/routes/swarm.test.ts`

Add tests for:
- `POST /sessions/:id/end` — ends an active session, returns 200 with status 'ended'
- `POST /sessions/:id/end` — returns 404 for nonexistent session
- `POST /sessions/:id/end` — can be called on an already-ended session (idempotent)
- `GET /sessions` — verify `count` reflects total, not just returned page size

**Dependencies**: Steps 1, 4, 5.

## Validation Criteria

- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm -r run lint` passes with zero errors
- [ ] LSP diagnostics are clean across all modified files
- [ ] `pnpm -r run test` passes (all existing tests + new tests)
- [ ] Terminate flow: clicking "Terminate" on an already-ended session updates its status to 'ended' in the UI
- [ ] Session detail: events display oldest-first (chronological), auto-scroll shows newest at bottom
- [ ] Sessions page: pagination shows correct total count, Next button activates when there are more sessions than the page size