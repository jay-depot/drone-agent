---
key: roadmap-phase2-memory
tags:
  - phase2
  - beacon
  - memory
  - planning
created: 2026-06-24T01:55:41.812Z
updated: 2026-06-24T01:55:41.812Z
---

# Phase 2: Beacon-Level Memory Store

## Design Decision

Based on the design-draft.md, there are three memory models:

1. **Event log** - Append-only, most flexible
2. **KV store with TTL** - Simple key-value with expiration
3. **Vector store** - For semantic search (Phase 5)

**Decision:** Start with **KV store with TTL** for beacon-level memory. It's:

- Simple to implement
- Predictable behavior
- Useful for inter-agent communication
- Can be extended later with event log

---

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  ttl INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory(namespace);
CREATE INDEX IF NOT EXISTS idx_memory_ttl ON memory(ttl);
```

**Fields:**

- `id` - Unique identifier (auto-generated UUID)
- `key` - The memory key (e.g., `project:foo:known-bugs`)
- `value` - JSON string value
- `namespace` - Agent-scoped namespace (default: `default`)
- `ttl` - Unix timestamp when this expires (null = never)
- `createdAt` - Creation timestamp
- `updatedAt` - Last update timestamp

---

## API Endpoints

| Method | Endpoint           | Description                               |
| ------ | ------------------ | ----------------------------------------- |
| GET    | `/memory`          | List all memories (with namespace filter) |
| GET    | `/memory/:id`      | Get a specific memory                     |
| POST   | `/memory`          | Create a memory                           |
| PUT    | `/memory/:id`      | Update a memory                           |
| DELETE | `/memory/:id`      | Delete a memory                           |
| GET    | `/memory/key/:key` | Get memory by key (in namespace)          |

---

## Request/Response Types

### CreateMemoryRequest

```typescript
interface CreateMemoryRequest {
  key: string; // e.g., "project:foo:known-bugs"
  value: string; // JSON string
  namespace?: string; // default: "default"
  ttlSeconds?: number; // null = never
}
```

### Memory Response

```typescript
interface Memory {
  id: string;
  key: string;
  value: string;
  namespace: string;
  ttl: number | null;
  createdAt: number;
  updatedAt: number;
  expired: boolean; // computed
}
```

---

## Implementation Plan

### Step 1: Add Types (types.ts)

- Add `Memory`, `CreateMemoryRequest`, `MemoryNamespace` types

### Step 2: Add Schema (db.ts)

- Add `memory` table to `initDatabase()`
- Add CRUD functions:
  - `createMemory(req, namespace?)`
  - `getMemory(id)`
  - `getMemoryByKey(key, namespace?)`
  - `listMemories(namespace?, includeExpired?)`
  - `updateMemory(id, req)`
  - `deleteMemory(id)`
  - `cleanupExpiredMemories()` - for TTL cleanup

### Step 3: Add Routes (routes.ts)

- Add memory endpoints

### Step 4: TTL Cleanup

- Add periodic cleanup task (runs every minute)
- Or clean on read (lazy expiration)

---

## Key Design Decisions

### Key Format

Use namespaced keys like `swarm:project:name:key`:

- `swarm:` - Prefix to avoid collisions
- `project:` - Project identifier
- `name:` - Logical data category
- `key` - Specific key

### TTL Behavior

- On read: Check if expired, return null if so (lazy expiration)
- Or periodic cleanup for performance

### Namespace

- Default namespace: `default`
- Agents can specify custom namespace
- Enables agent-scoped isolation if needed

---

## Usage Examples

### Store a fact

```bash
curl -X POST http://localhost:3457/memory \
  -H "Content-Type: application/json" \
  -d '{
    "key": "project:myapp:known-bugs",
    "value": "[\"login-timeout\", \"cache-invalidated\"]",
    "namespace": "agent-1",
    "ttlSeconds": 604800
  }'
```

### Retrieve

```bash
# Get by key
curl http://localhost:3457/memory/key/project:myapp:known-bugs?namespace=agent-1

# List all in namespace
curl http://localhost:3457/memory?namespace=agent-1
```

---

## Future Extensions

1. **Event log** - Append-only log for facts
2. **Vector store** - For semantic search (Phase 5)
3. **Pub/Sub** - Real-time notifications on memory changes
4. **Coordinator sync** - Beacon memory syncs to coordinator
