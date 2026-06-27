---
key: phase-3.3-global-memory-skills
tags:
  - phase-3.3
  - implementation
  - knowledge-registry
  - coordinator
  - beacon
created: 2026-06-27T17:47:21.488Z
updated: 2026-06-27T17:47:21.488Z
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

## Implementation Order

1. **Step 1**: Add `knowledge` table and types to coordinator DB
2. **Step 2**: Add `/knowledge` REST endpoints to coordinator
3. **Step 3**: Add sync endpoints (`/sync/knowledge/push`, `/sync/knowledge/pull`)
4. **Step 4**: Update beacon's coordinator client with knowledge sync methods
5. **Step 5**: Add local knowledge cache to beacon DB
6. **Step 6**: Integrate sync into beacon lifecycle (startup, periodic)
7. **Step 7**: Add config options to drone-core
8. **Step 8**: Add tests

## Considerations

- **Conflict resolution**: If same `type` + `key` from multiple beacons, keep highest confidence or latest timestamp
- **Offline support**: Beacon caches knowledge locally; works when coordinator is down
- **Security**: No auth needed (single-user) but could add optional API key
- **TTL**: Knowledge doesn't expire by default, but could add optional TTL