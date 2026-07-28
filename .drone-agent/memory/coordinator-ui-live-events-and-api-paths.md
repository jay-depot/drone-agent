---
key: coordinator-ui-live-events-and-api-paths
tags:
  - plan
  - coordinator-ui
  - live-events
  - api-paths
created: 2026-07-28T17:15:14.479Z
updated: 2026-07-28T17:15:14.479Z
---

# Plan: Coordinator UI Live Events + API Path Fix

## Summary

Two issues that are interdependent (the `/api` prefix affects where `publishEvent` calls go, and the beacon needs updated URLs to test):

**Issue 3: Live event streaming** — The `publishEvent()` function in `ws-pubsub.ts` is fully implemented but never called. ~30+ mutation endpoints across the coordinator should call it. Phase 1 wires up the critical ones (events push, session lifecycle, agent location) with a helper function to make Phase 2 (personas, skills, wiki, knowledge, insights, principles, beacons) trivial.

**Issue 4: SPA path conflicts** — API routes are registered at root level (e.g., `GET /sessions/:id/events`), and SPA routes use the same paths (e.g., `/sessions/:sessionId`). Refreshing any page returns JSON instead of the SPA. Fix: prefix all API routes with `/api`. The Vite dev proxy already proxies `/api` to the coordinator, so this will work immediately.

## Steps

### Step 1: Add `publishEvent` helper and wire up critical endpoints (coordinator)

**File**: `drone-coordinator/src/ws-pubsub.ts`

Add a convenience helper that wraps `publishEvent` with error handling and logging, making it easy to call from any route handler:

```typescript
export function publishMutationEvent(event: {
  sessionId: string;
  eventType: string;
  payload?: unknown;
}): void {
  try {
    publishEvent(event);
  } catch (err) {
    logger.warn(`Failed to publish event: ${err}`);
  }
}
```

**File**: `drone-coordinator/src/routes/swarm.ts`

Add import: `import { publishMutationEvent } from '../ws-pubsub.js';`

Wire up `publishMutationEvent` in these handlers:

1. **`POST /sync/sessions/register`** — after `db.createSwarmSession()`:

   ```typescript
   publishMutationEvent({
     sessionId: id,
     eventType: 'session.created',
     payload: { sessionId: id, personaId, beaconId, status: 'active' },
   });
   ```

2. **`DELETE /sync/sessions/:id`** — after `db.updateSwarmSessionStatus()`:

   ```typescript
   publishMutationEvent({
     sessionId: request.params.id,
     eventType: 'session.ended',
     payload: { sessionId: request.params.id, status: 'ended' },
   });
   ```

3. **`POST /sync/events/push`** — in the loop, after `db.createSwarmEvent()`:

   ```typescript
   publishMutationEvent({
     sessionId: evt.sessionId,
     eventType: evt.type,
     payload: evt.payload,
   });
   ```

4. **`POST /sessions/:id/process`** — after successful transition:

   ```typescript
   publishMutationEvent({
     sessionId: request.params.id,
     eventType: 'session.processing',
     payload: { sessionId: request.params.id, status: 'processing' },
   });
   ```

5. **`POST /sessions/:id/processed`** — after successful transition:

   ```typescript
   publishMutationEvent({
     sessionId: request.params.id,
     eventType: 'session.processed',
     payload: { sessionId: request.params.id, status: 'processed' },
   });
   ```

6. **`POST /agents/location`** — after `db.registerAgentLocation()`:

   ```typescript
   publishMutationEvent({
     sessionId: agentId,
     eventType: 'agent.connected',
     payload: { agentId, beaconId, personaId },
   });
   ```

7. **`DELETE /agents/location/:agentId`** — after `db.unregisterAgentLocation()`:
   ```typescript
   publishMutationEvent({
     sessionId: request.params.agentId,
     eventType: 'agent.disconnected',
     payload: { agentId: request.params.agentId },
   });
   ```

**File**: `drone-coordinator/src/routes/beacons.ts`

Add import: `import { publishMutationEvent } from '../ws-pubsub.js';`

Wire up in:

1. **`POST /beacons/:id/sessions`** — after `db.createBeaconSession()`:

   ```typescript
   publishMutationEvent({
     sessionId: request.body.agentId,
     eventType: 'beacon.session.created',
     payload: { beaconId: request.params.id, ...request.body },
   });
   ```

2. **`DELETE /beacons/:id/sessions/:agentId`** — after `db.endBeaconSession()`:
   ```typescript
   publishMutationEvent({
     sessionId: request.params.agentId,
     eventType: 'beacon.session.ended',
     payload: { beaconId: request.params.id, agentId: request.params.agentId },
   });
   ```

**Dependencies**: None.

### Step 2: Prefix all coordinator API routes with `/api`

**File**: `drone-coordinator/src/routes/index.ts`

Wrap all route registrations (except health) in a scoped Fastify instance with `/api` prefix:

```typescript
import type { FastifyInstance } from 'fastify';
import health from './health.js';
import personas from './personas.js';
import skills from './skills.js';
import beacons from './beacons.js';
import knowledge from './knowledge.js';
import insights from './insights.js';
import principles from './principles.js';
import wiki from './wiki.js';
import swarm from './swarm.js';
import messages from './messages.js';
import spawn from './spawn.js';

export async function registerRoutes(app: FastifyInstance) {
  // Health stays at root level (exempted by SPA fallback)
  health(app);

  // All other routes under /api prefix
  await app.register(
    async api => {
      personas(api);
      skills(api);
      beacons(api);
      knowledge(api);
      insights(api);
      principles(api);
      wiki(api);
      swarm(api);
      messages(api);
      spawn(api);
    },
    { prefix: '/api' }
  );
}
```

**No changes needed** to individual route files — the paths inside them (e.g., `/personas`, `/beacons/:id/sessions/:agentId`) stay the same. The prefix is applied at registration time.

**File**: `drone-coordinator/src/index.ts`

The `setNotFoundHandler` already exempts `/api` — no change needed there.

**Dependencies**: None.

### Step 3: Update beacon coordinator-client.ts URLs

**File**: `drone-beacon/src/coordinator-client.ts`

All 34 `baseUrl` references need `/api` inserted before the path. The pattern is:

```typescript
// Before:
`${baseUrl}/beacons``${baseUrl}/sync/sessions/register``${baseUrl}/sessions?${params}`
// After:
`${baseUrl}/api/beacons``${baseUrl}/api/sync/sessions/register``${baseUrl}/api/sessions?${params}`;
```

Affected lines (by line number from search):

- Line 194: `${baseUrl}/beacons`
- Line 232: `${baseUrl}/beacons/trust/${config.beaconId}`
- Line 249: `${baseUrl}/beacons/${config.beaconId}/heartbeat`
- Line 263: `${baseUrl}/personas`
- Line 274: `${baseUrl}/skills`
- Line 291: `${baseUrl}/beacons/${config.beaconId}/sessions`
- Line 317: `${baseUrl}/beacons/${config.beaconId}/sessions/${agentId}`
- Line 345: `${baseUrl}/agents/location`
- Line 367: `${baseUrl}/agents/location/${agentId}/heartbeat`
- Line 384: `${baseUrl}/agents/location/${agentId}`
- Line 403: `${baseUrl}/messages/relay`
- Line 431: `${baseUrl}/personas`
- Line 448: `${baseUrl}/skills`
- Line 465: `${baseUrl}/personas/${id}`
- Line 480: `${baseUrl}/skills/${id}`
- Line 496: `${baseUrl}/sync/knowledge/push`
- Line 513: `${baseUrl}/sync/knowledge/pull`
- Line 531: `${baseUrl}/knowledge/search?q=...`
- Line 553: `${baseUrl}/sync/sessions/register`
- Line 574: `${baseUrl}/sync/sessions/${sessionId}`
- Line 599: `${baseUrl}/sync/events/push`
- Line 622: `${baseUrl}/sync/tools/push`
- Line 641: `${baseUrl}/tools/default-hidden`
- Line 658: `${baseUrl}/sessions?...`
- Line 672: `${baseUrl}/sessions/${sessionId}/log`
- Line 686: `${baseUrl}/sessions/${sessionId}/process`
- Line 705: `${baseUrl}/sessions/${sessionId}/processed`

**Dependencies**: Step 2 (the routes must exist at `/api/...`).

### Step 4: Update all UI authFetch calls to use `/api` prefix

**File**: All 14 page files in `drone-coordinator-ui/src/pages/`

Every `authFetch(...)` call needs `/api` prepended to the URL path. The full list of changes:

| File                 | Current URL                          | New URL                                  |
| -------------------- | ------------------------------------ | ---------------------------------------- |
| `topology.tsx`       | `/beacons`                           | `/api/beacons`                           |
| `topology.tsx`       | `/agents/location`                   | `/api/agents/location`                   |
| `topology.tsx`       | `/beacons/approve`                   | `/api/beacons/approve`                   |
| `topology.tsx`       | `/beacons/trust/${id}/reject`        | `/api/beacons/trust/${id}/reject`        |
| `topology.tsx`       | `/beacons/trust/${id}`               | `/api/beacons/trust/${id}`               |
| `beacon-detail.tsx`  | `/beacons/${id}`                     | `/api/beacons/${id}`                     |
| `beacon-detail.tsx`  | `/beacons/${id}/sessions`            | `/api/beacons/${id}/sessions`            |
| `beacon-detail.tsx`  | `/agents/location?beaconId=${id}`    | `/api/agents/location?beaconId=${id}`    |
| `sessions.tsx`       | `/sessions?limit=...`                | `/api/sessions?limit=...`                |
| `sessions.tsx`       | `/beacons`                           | `/api/beacons`                           |
| `sessions.tsx`       | `/beacons/${id}/sessions/${agentId}` | `/api/beacons/${id}/sessions/${agentId}` |
| `sessions.tsx`       | `/sessions/${id}/process`            | `/api/sessions/${id}/process`            |
| `sessions.tsx`       | `/sessions/${id}/processed`          | `/api/sessions/${id}/processed`          |
| `session-detail.tsx` | `/sessions/${sessionId}/events`      | `/api/sessions/${sessionId}/events`      |
| `personas.tsx`       | `/personas`                          | `/api/personas`                          |
| `personas.tsx`       | `/personas/${id}`                    | `/api/personas/${id}`                    |
| `persona-detail.tsx` | `/personas/${id}`                    | `/api/personas/${id}`                    |
| `persona-editor.tsx` | `/personas/${id}`                    | `/api/personas/${id}`                    |
| `persona-editor.tsx` | `/personas`                          | `/api/personas`                          |
| `skills.tsx`         | `/skills`                            | `/api/skills`                            |
| `skills.tsx`         | `/skills/${id}`                      | `/api/skills/${id}`                      |
| `skill-detail.tsx`   | `/skills/${id}`                      | `/api/skills/${id}`                      |
| `skill-editor.tsx`   | `/skills/${id}`                      | `/api/skills/${id}`                      |
| `skill-editor.tsx`   | `/skills`                            | `/api/skills`                            |
| `wiki.tsx`           | `/wiki`                              | `/api/wiki`                              |
| `wiki.tsx`           | `/wiki/search?q=...`                 | `/api/wiki/search?q=...`                 |
| `wiki.tsx`           | `/wiki/${id}`                        | `/api/wiki/${id}`                        |
| `wiki-detail.tsx`    | `/wiki/${pageId}`                    | `/api/wiki/${pageId}`                    |
| `wiki-editor.tsx`    | `/wiki/${pageId}`                    | `/api/wiki/${pageId}`                    |

**File**: `drone-coordinator-ui/src/pages/login.tsx`

Check if it uses `fetch('/health')` — if so, it stays as-is since `/health` is not under `/api`.

**Dependencies**: Step 2 (the routes must exist at `/api/...`).

### Step 5: Update coordinator test URLs

**File**: `drone-coordinator/test/routes/swarm.test.ts`
**File**: `drone-coordinator/test/routes/beacons.test.ts`
**File**: `drone-coordinator/test/routes/personas.test.ts`
**File**: `drone-coordinator/test/routes/skills.test.ts`
**File**: `drone-coordinator/test/routes/insights.test.ts`
**File**: `drone-coordinator/test/routes/principles.test.ts`
**File**: `drone-coordinator/test/routes/knowledge.test.ts`
**File**: `drone-coordinator/test/routes/messages.test.ts`
**File**: `drone-coordinator/test/routes/spawn.test.ts`
**File**: `drone-coordinator/test/routes/edge-cases.test.ts`
**File**: `drone-coordinator/test/routes/health.test.ts`

All test URLs that hit API routes need `/api` prepended. For example:

- `url: '/sync/sessions/register'` → `url: '/api/sync/sessions/register'`
- `url: '/sessions'` → `url: '/api/sessions'`
- `url: '/personas'` → `url: '/api/personas'`

The health test stays as-is (`url: '/health'`).

**Dependencies**: Step 2.

### Step 6: Add tests for live event publishing

**File**: `drone-coordinator/test/routes/swarm.test.ts`

Add tests that verify `publishEvent` is called when events are pushed. Since `publishEvent` broadcasts to WebSocket subscribers (which don't exist in test), the test should verify that:

- The route handler completes successfully (status 201)
- Events are stored in the database

This is already covered by existing tests for `/sync/events/push`. The key change is that the handler now also calls `publishMutationEvent`, which is a fire-and-forget broadcast — it won't affect the response. The existing tests should continue to pass.

**Dependencies**: Step 1.

## Validation Criteria

- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm -r run lint` passes with zero errors
- [ ] LSP diagnostics are clean across all modified files
- [ ] `pnpm -r run test` passes (all existing tests + any new tests)
- [ ] Refreshing any SPA page (e.g., `/sessions`, `/personas/some-id`, `/wiki/my-page`) returns the SPA, not JSON
- [ ] New events pushed from a beacon appear in the session detail page in real time (via WebSocket)
- [ ] Session lifecycle changes (register, end, process, processed) appear in the sessions list in real time
- [ ] Agent location changes appear in the topology page in real time
- [ ] Beacon coordinator-client.ts successfully connects to coordinator at `/api/...` paths
