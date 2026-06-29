---
key: routes-refactor-plan
tags:
  - refactor
  - routes
  - beacon
  - coordinator
created: 2026-06-29T02:43:11.839Z
updated: 2026-06-29T02:43:11.839Z
---

# Plan: Split `routes.ts` into Domain-Specific Route Files

## Summary

The `routes.ts` files in both `drone-beacon` (1132 lines) and `drone-coordinator` (808 lines) have grown large and should be split into per-domain files under a `routes/` directory. This improves maintainability, makes it easier to find specific route handlers, and reduces merge conflicts when multiple people work on different route groups.

## Architecture

### Beacon: `drone-beacon/src/routes/` directory

**`context.ts`** — Shared state, setters, and proxy helpers (extracted from current module-level code)
- Module-level mutable state: `coordinatorClient`, `beaconHost`, `beaconPort`
- Exported setters: `setCoordinatorClient()`, `setBeaconAddress()`
- Internal helpers: `getCoordinatorClient()`, `getBeaconUrl()`
- Proxy helpers: `proxyToCoordinator()`, `proxyWikiToCoordinator()` (used by insights, principles, wiki)
- Exported: `triggerCoordinatorSync()` (called from `index.ts`)
- Query interfaces: `MemoryQuery`, `SpawnQuery`, `EventQuery`

**`health.ts`** — GET /health

**`personas.ts`** — POST/GET /personas, GET/PUT/DELETE /personas/:id

**`skills.ts`** — POST/GET /skills, GET/PUT/DELETE /skills/:id

**`agents.ts`** — POST/GET /agents, GET/POST/DELETE /agents/:id, POST /agents/:id/heartbeat

**`memory.ts`** — POST/GET /memory, GET /memory/:id, GET /memory/key/:key, PUT/DELETE /memory/:id

**`messages.ts`** — POST/GET /messages, GET /messages/:id, POST /messages/:id/read, GET /messages/channel/:channel

**`spawn.ts`** — POST/GET /spawn, GET/DELETE /spawn/:spawnId

**`config.ts`** — GET /config, GET /config/:key, POST /config, PUT/DELETE /config/:key

**`events.ts`** — GET /events, GET /events/:id

**`insights.ts`** — POST/GET /insights, GET/DELETE /insights/:id (with coordinator proxy via `?scope=coordinator`)

**`principles.ts`** — POST/GET /principles, GET/DELETE /principles/:id (with coordinator proxy via `?scope=coordinator`)

**`wiki.ts`** — GET /wiki, GET /wiki/:pageId, PUT /wiki/:pageId, DELETE /wiki/:pageId, GET /wiki/search, POST /wiki/lint (with coordinator proxy via `?scope=coordinator`)

**`sync.ts`** — POST /sync (manual coordinator sync trigger)

**`index.ts`** — Re-exports `registerRoutes` which imports all domain files and calls each one with the Fastify instance

### Coordinator: `drone-coordinator/src/routes/` directory

**`health.ts`** — GET /health

**`personas.ts`** — POST/GET /personas, GET/PUT/DELETE /personas/:id

**`skills.ts`** — POST/GET /skills, GET/PUT/DELETE /skills/:id

**`beacons.ts`** — Beacon registration (legacy + trust), approval, beacon sessions
- POST/GET /beacons, GET /beacons/:id
- POST/GET /beacons/trust, GET/DELETE /beacons/trust/:id
- POST /beacons/approve, POST /beacons/trust/:id/reject
- POST/GET /beacons/:id/sessions, GET/DELETE /beacons/:id/sessions/:agentId

**`knowledge.ts`** — Knowledge CRUD + search + sync
- POST/GET /knowledge, GET/PUT/DELETE /knowledge/:id, GET /knowledge/search
- POST /sync/knowledge/push, GET /sync/knowledge/pull

**`insights.ts`** — POST/GET /insights, GET/DELETE /insights/:id

**`principles.ts`** — POST/GET /principles, GET/DELETE /principles/:id

**`wiki.ts`** — GET /wiki, GET /wiki/:pageId, PUT /wiki/:pageId, DELETE /wiki/:pageId, GET /wiki/search, POST /wiki/lint

**`swarm.ts`** — Swarm sessions, events, agent locations
- POST /sync/sessions/register, POST /sync/events/push
- GET /sessions/:id/events, GET /sessions/:id/events/latest, GET /events/search
- POST/GET /agents/location, GET/POST/DELETE /agents/location/:agentId

**`messages.ts`** — POST /messages/relay, POST /messages/broadcast

**`index.ts`** — Re-exports `registerRoutes` which imports all domain files and calls each one

## Import Pattern

Each route file exports a default function that takes the Fastify instance:

```ts
// routes/personas.ts
import type { FastifyInstance } from 'fastify';
import * as db from '../db.js';
import { getCoordinatorClient } from './context.js';
import { logger } from '../logger.js';

export default function(app: FastifyInstance) {
  app.post<{ Body: CreatePersonaRequest }>('/personas', async (request, reply) => {
    // ... handler
  });
  // ... other persona routes
}
```

The `routes/index.ts` assembles them:

```ts
// routes/index.ts
import type { FastifyInstance } from 'fastify';
import health from './health.js';
import personas from './personas.js';
import skills from './skills.js';
// ... etc

export async function registerRoutes(app: FastifyInstance) {
  health(app);
  personas(app);
  skills(app);
  // ... etc
}
```

## Steps

### Step 1: Create beacon `routes/` directory and `context.ts`
- Create `drone-beacon/src/routes/` directory
- Extract module-level state, setters, helpers, proxy functions, and `triggerCoordinatorSync` into `context.ts`
- Extract `MemoryQuery`, `SpawnQuery`, `EventQuery` interfaces into `context.ts`

### Step 2: Create beacon route files (one per domain)
- Create each file listed above, extracting the relevant route handlers from `routes.ts`
- Each file imports from `./context.js` and `../db.js` as needed

### Step 3: Create beacon `routes/index.ts`
- Import all domain files
- Export `registerRoutes` that calls each one

### Step 4: Update beacon `index.ts` import
- Change `from './routes.js'` to `from './routes/index.js'`
- Keep the same named exports: `registerRoutes`, `setCoordinatorClient`, `setBeaconAddress`, `triggerCoordinatorSync`

### Step 5: Delete old beacon `routes.ts`

### Step 6: Create coordinator `routes/` directory and route files
- Create `drone-coordinator/src/routes/` directory
- Create each file listed above, extracting the relevant route handlers from `routes.ts`
- Each file imports from `../db.js` and `../storage.js` as needed

### Step 7: Create coordinator `routes/index.ts`
- Import all domain files
- Export `registerRoutes` that calls each one

### Step 8: Update coordinator `index.ts` import
- Change `from './routes.js'` to `from './routes/index.js'`

### Step 9: Delete old coordinator `routes.ts`

### Step 10: Run validation
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`

### Step 11: Commit

## Validation Criteria
- `pnpm typecheck` passes
- `pnpm lint` passes
- `pnpm test` passes (all 500+ tests)
- Beacon and coordinator start up correctly with all routes registered
- No behavioral changes — this is a pure structural refactor