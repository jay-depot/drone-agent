---
key: swarm-learning-insights-principles-plan
tags:
  - swarm-learning
  - self-improvement
  - insights
  - principles
  - phase-3.4
  - completed
created: 2026-06-29T01:37:23.458Z
updated: 2026-06-29T02:04:39.721Z
---

# Part 1: Swarm-wide Insights & Principles Promotion

## Summary

Make the self-improvement system scope-aware so that insights and principles for swarm-scoped identity assets (beacon/coordinator personas and skills) are stored on the owning server rather than local files. The self-improvement plugin becomes a storage broker that delegates to provider-registered storage engines.

## Architecture

### Storage Broker Pattern

The self-improvement plugin becomes a broker, mirroring the existing persona/skill broker+provider pattern:

- **Broker** (self-improvement plugin): routes insight/principle reads/writes to the owning provider's storage engine. Asks the persona/skill broker for the owning provider ID, then delegates to that provider's registered storage engine.
- **Providers** register storage engines at registration time, keyed by provider ID:
  - `persona-provider-project` / `skill-provider-project` → file-based (current behavior, `.drone-agent/insights/`)
  - `persona-provider-user` / `skill-provider-user` → file-based (current behavior, `~/.drone-agent/insights/`)
  - `swarm-persona-beacon` / `swarm-skill-beacon` → HTTP (beacon's new `/insights` and `/principles` endpoints)
  - `swarm-persona-coordinator` / `swarm-skill-coordinator` → HTTP (proxied through beacon to coordinator)

### Server Storage (New Tables)

Beacon and coordinator each gain **separate** `insights` and `principles` tables (NOT the knowledge table — clean scope separation):

**insights table:**
- `id` (TEXT PK)
- `targetType` (TEXT — persona, skill, project)
- `targetId` (TEXT — the persona/skill/project ID)
- `insight` (TEXT — 1-3 sentence observation)
- `timestamp` (TEXT — ISO-8601)
- `scope` (TEXT — 'beacon' or 'coordinator')

**principles table:**
- `id` (TEXT PK)
- `targetType` (TEXT)
- `targetId` (TEXT)
- `principle` (TEXT — concise actionable statement)
- `source` (TEXT — optional, e.g., "Derived from 3 insights about code style")
- `createdAt` (TEXT — ISO-8601)
- `scope` (TEXT — 'beacon' or 'coordinator')

### New Endpoints

**Beacon** (serves local + proxies coordinator):
- `POST /insights` — create insight
- `GET /insights?targetType=...&targetId=...` — list insights for target
- `GET /insights/:id` — get insight
- `DELETE /insights/:id` — delete insight
- `POST /principles` — create principle
- `GET /principles?targetType=...&targetId=...` — list principles for target
- `GET /principles/:id` — get principle
- `DELETE /principles/:id` — delete principle
- All of the above with optional `?scope=coordinator` to proxy to coordinator

### Principle Injection

The self-improvement plugin's prompt fragment (footer phase) reads principles from ALL relevant providers and injects them into the system prompt. For a swarm-scoped persona, this means fetching principles from the beacon/coordinator via HTTP.

### Derivation Model

- **Default**: Agent-side derivation — the agent reads accumulated insights from the owning server, derives principles, writes them back. Server is just storage.
- **Possible**: Server-side derivation — user can wire up cron jobs + custom prompts to run derivation on the server. The architecture doesn't prevent this; the server exposes full CRUD for both insights and principles.

## Implementation Status

### ✅ Completed

#### drone-core
- Added `DroneInsightEntry`, `DroneInsightStorageEngine`, `DronePrincipleStorageEngine`, `DroneSelfImprovementCapability` types to `capabilities.ts`
- Exported all new types from `index.ts`

#### drone-coordinator
- Added `insights` and `principles` tables to `initDatabase()` schema
- Added CRUD functions: `createInsight`, `listInsights`, `getInsight`, `deleteInsight`, `createPrinciple`, `listPrinciples`, `getPrinciple`, `deletePrinciple`
- Added `/insights` and `/principles` REST endpoints (POST, GET list, GET by id, DELETE)
- Fixed missing `randomUUID` import

#### drone-beacon
- Added `insights` and `principles` tables to `initDatabase()` schema
- Added CRUD functions matching coordinator
- Added `/insights` and `/principles` endpoints with `?scope=coordinator` proxy support
- Added `getBaseUrl()` method to `CoordinatorClient` interface and implementation (for proxying)

#### drone-agent
- Refactored `self-improvement` plugin from file-only to broker pattern:
  - Maintains in-memory registries for insight and principle storage engines
  - Default file-based engines for local-scoped targets (project/user)
  - Scope-based routing: checks if target is swarm-scoped (beacon/coordinator) and routes to registered HTTP engine
  - Falls back to file-based engine when no registered engine matches
  - Offers `DroneSelfImprovementCapability` for engine registration
  - Offers `DronePrinciplesCapability` for backwards compatibility
- Registered HTTP storage engines in `swarm` plugin's `onPluginsLoaded` hook:
  - `swarm-insight-beacon` engine calls beacon's `/insights` endpoints
  - `swarm-principle-beacon` engine calls beacon's `/principles` endpoints
  - Added `self-improvement` as optional dependency in swarm plugin metadata

#### Test Fixtures
- Fixed all `.js` extension issues in test fixture imports (4 files)

### Validation
- `pnpm typecheck` passes for all 4 packages + test config
- `pnpm lint` passes

## Files Modified

### drone-core
- `src/capabilities.ts` — added new types
- `src/index.ts` — exported new types

### drone-coordinator
- `src/db.ts` — added tables + CRUD, fixed missing import
- `src/routes.ts` — added endpoints

### drone-beacon
- `src/db.ts` — added tables + CRUD
- `src/routes.ts` — added endpoints + coordinator proxy
- `src/coordinator-client.ts` — added `getBaseUrl()`

### drone-agent
- `src/plugins/self-improvement/index.ts` — refactored to broker pattern
- `src/plugins/swarm/index.ts` — added HTTP storage engine registration, optional dependency
- `test/fixtures/index.ts` — added .js extensions
- `test/fixtures/assertions.ts` — added .js extension
- `test/fixtures/http.ts` — added .js extension
- `test/fixtures/swarm.ts` — added .js extensions