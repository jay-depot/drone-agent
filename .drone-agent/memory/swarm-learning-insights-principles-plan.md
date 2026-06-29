---
key: swarm-learning-insights-principles-plan
tags:
  - swarm-learning
  - self-improvement
  - insights
  - principles
  - phase-3.4
created: 2026-06-29T01:37:23.458Z
updated: 2026-06-29T01:37:23.458Z
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

## Files to Modify/Create

### drone-agent

- `src/plugins/self-improvement/index.ts` — refactor from file-only to broker pattern; add storage engine routing
- `src/plugins/swarm/index.ts` — register insight/principle storage engines for swarm providers
- `src/plugins/persona-provider-project/index.ts` — register file-based storage engine
- `src/plugins/persona-provider-user/index.ts` — register file-based storage engine
- `src/plugins/skill-provider-project/index.ts` — register file-based storage engine
- `src/plugins/skill-provider-user/index.ts` — register file-based storage engine
- `drone-core/src/capabilities.ts` — add `DroneInsightStorageEngine` and `DronePrincipleStorageEngine` types

### drone-beacon

- `src/db.ts` — add `insights` and `principles` tables + CRUD
- `src/routes.ts` — add `/insights` and `/principles` endpoints + coordinator proxy
- `src/coordinator-client.ts` — add insight/principle proxy methods

### drone-coordinator

- `src/db.ts` — add `insights` and `principles` tables + CRUD
- `src/routes.ts` — add `/insights` and `/principles` endpoints

### Tests

- `drone-agent/test/` — self-improvement broker routing tests
- `drone-beacon/test/` — insight/principle endpoint tests
- `drone-coordinator/test/` — insight/principle endpoint tests

## Validation Criteria

- All LSP checks pass
- `pnpm typecheck` passes
- `pnpm lint` passes
- `pnpm test` passes
- Local-scoped insights/principles still work exactly as before (file-based)
- Swarm-scoped insights are stored on the beacon, not local files
- Swarm-scoped principles are injected into the system prompt from the beacon
- Beacon proxies coordinator insight/principle requests when `?scope=coordinator`
