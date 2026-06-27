---
key: phase-3.3-global-memory-skills
tags:
  []
created: 2026-06-27T17:47:21.488Z
updated: 2026-06-27T20:19:01.075Z
---

# Phase 3.3: Global Memory & Skills - Implementation Plan

## Overview

The goal is to create a **knowledge registry** in the coordinator that stores YOUR swarm-wide knowledge — facts, patterns, preferences, and skill insights — accessible to all YOUR beacons across all YOUR machines.

## Data Model

Add a new `knowledge` table to the coordinator DB:

```sql
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'skill_pattern' | 'fact' | 'preference' | 'principle'
  key TEXT NOT NULL,            -- unique identifier within type
  value TEXT NOT NULL,          -- JSON-encoded content
  source_beacon_id TEXT,        -- which beacon contributed this
  source_agent_id TEXT,         -- which agent contributed this
  confidence REAL DEFAULT 1.0,  -- how confident we are (for pattern aggregation)
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
CREATE INDEX IF NOT EXISTS idx_knowledge_key ON knowledge(key);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge(source_beacon_id);
```

## Knowledge Types

| Type | Description | Example |
|------|-------------|---------|
| `fact` | Verified fact across swarm | `"vite": "Use Vite for TypeScript projects"` |
| `preference` | User preference | `"theme": "dark"` |
| `skill_pattern` | Learned pattern from skill usage | `"test-pattern": "Always add tests before refactoring"` |
| `principle` | Derived principle from insights | `"code-style": "Prefer explicit over implicit"` |

## API Endpoints

### Coordinator routes (`/knowledge`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/knowledge` | List knowledge with optional filtering by `type` |
| `GET` | `/knowledge/:id` | Get single knowledge entry |
| `POST` | `/knowledge` | Create knowledge entry |
| `PUT` | `/knowledge/:id` | Update knowledge entry |
| `DELETE` | `/knowledge/:id` | Delete knowledge entry |
| `GET` | `/knowledge/search?q=` | Full-text search across knowledge |

### Beacon → Coordinator sync

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sync/knowledge/push` | Beacon pushes knowledge to coordinator |
| `GET` | `/sync/knowledge/pull` | Beacon pulls latest knowledge from coordinator |

## Beacon Integration

1. **On beacon startup**: Pull knowledge from coordinator (if connected)
2. **On agent insight**: Optionally push to coordinator (if enabled)
3. **Periodic sync**: Configurable interval to pull updates
4. **Local cache**: Beacon caches knowledge for offline operation

## Config Options

```typescript
// In drone-agent or drone-beacon config
swarm: {
  // ... existing config
  knowledgeSync: {
    enabled: boolean,           // default: true
    pushInsights: boolean,      // push insights to coordinator, default: true
    pullOnStartup: boolean,     // pull knowledge on beacon start, default: true
    pullIntervalMinutes: number, // periodic pull, default: 60
  }
}
```

## Implementation Files

| File | Changes |
|------|---------|
| `drone-coordinator/src/db.ts` | Add `knowledge` table and CRUD operations |
| `drone-coordinator/src/routes.ts` | Add `/knowledge` and `/sync/knowledge/*` routes |
| `drone-coordinator/src/types.ts` | Add knowledge types |
| `drone-beacon/src/coordinator-client.ts` | Add push/pull knowledge methods |
| `drone-beacon/src/db.ts` | Add local knowledge cache table |
| `drone-beacon/src/routes.ts` | Add `/sync/knowledge/*` endpoints |
| `drone-beacon/src/index.ts` | Integrate knowledge sync on startup |
| `drone-core/src/config-types.ts` | Add `knowledgeSync` config options |
| `drone-core/src/config-schema.ts` | Add swarm config schema |
| `drone-core/src/index.ts` | Export new types |
| `drone-coordinator/test/knowledge.test.ts` | Add tests |

## Implementation Order

1. **Step 1**: Add `knowledge` table and types to coordinator DB ✅
2. **Step 2**: Add `/knowledge` REST endpoints to coordinator ✅
3. **Step 3**: Add sync endpoints (`/sync/knowledge/push`, `/sync/knowledge/pull`) ✅
4. **Step 4**: Update beacon's coordinator client with knowledge sync methods ✅
5. **Step 5**: Add local knowledge cache to beacon DB ✅
6. **Step 6**: Integrate sync into beacon lifecycle (startup, periodic) ✅
7. **Step 7**: Add config options to drone-core ✅
8. **Step 8**: Add tests ✅

## Considerations

- **Conflict resolution**: If same `type` + `key` from multiple beacons, keep highest confidence or latest timestamp
- **Offline support**: Beacon caches knowledge locally; works when coordinator is down
- **Security**: No auth needed (single-user) but could add optional API key
- **TTL**: Knowledge doesn't expire by default, but could add optional TTL

## Work Completed (2026-06-27)

All 8 steps of the implementation plan have been completed:

1. **Coordinator DB**: Added `knowledge` table with indexes, plus CRUD operations (`createKnowledge`, `getKnowledge`, `listKnowledge`, `updateKnowledge`, `deleteKnowledge`, `searchKnowledge`, `upsertKnowledge`). The `upsertKnowledge` function implements conflict resolution by keeping the entry with the highest confidence.

2. **Coordinator Routes**: Added full REST API at `/knowledge` (CRUD + search) and sync endpoints at `/sync/knowledge/push` (upsert) and `/sync/knowledge/pull` (list with optional `since` timestamp filter).

3. **Beacon Coordinator Client**: Added `pushKnowledge`, `pullKnowledge`, and `searchKnowledge` methods to the `CoordinatorClient` interface and implementation.

4. **Beacon DB**: Added `knowledge_cache` table with `cacheKnowledge`, `getCachedKnowledge`, `listCachedKnowledge`, `clearKnowledgeCache`, and `replaceKnowledgeCache` operations. The `replaceKnowledgeCache` uses a transaction for atomic replacement.

5. **Beacon Lifecycle**: Updated `triggerCoordinatorSync` in `routes.ts` to also pull knowledge from the coordinator and cache it locally. This runs on startup and periodically.

6. **Config**: Added `DroneKnowledgeSyncConfig` and `DroneSwarmConfig` types to `drone-core`, with defaults (`enabled: true`, `pushInsights: true`, `pullOnStartup: true`, `pullIntervalMinutes: 60`). Added schema validation in `config-schema.ts` and config layering in `applyAgentConfigLayer`.

7. **Tests**: 13 tests covering all knowledge CRUD operations, search, filtering, and upsert conflict resolution. All 495 tests pass.

**Commit**: `bd91f09`