---
key: beacon-config-override-spec
tags:
  - beacon
  - config
  - override
  - spec
  - phase2
created: 2026-06-25T03:48:04.214Z
updated: 2026-06-25T03:48:04.214Z
---

# Beacon-Level Config Override Specification

## Problem

Currently the config system cascades as:
- Project > User > Beacon > Coordinator > System defaults

But there's no way for the beacon to actively **override** or **inject** config into this cascade. This is needed for:

1. **Environment-specific settings**: Beacon host has specific model URLs, API keys, etc.
2. **Beacon-controlled features**: Enable/disable certain behaviors across all agents on this host
3. **Swarm coordination**: Beacon wants to tell all agents about shared resources (e.g., "use this model for coding")

## Current State

The beacon stores:
- Personas
- Skills  
- Memory (KV store)
- Messages

But it doesn't store or serve configuration overrides.

## Proposed Solution

### 1. Beacon Config Store

Add a `beacon_config` table to store overrides:

```sql
CREATE TABLE IF NOT EXISTS beacon_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,  -- JSON string
  scope TEXT NOT NULL DEFAULT 'local',  -- 'local' or 'swarm' (synced to coordinator)
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
```

### 2. Config Merge Strategy

When agent connects to beacon:
1. Agent sends its current config (or just requests beacon config)
2. Beacon returns its overrides
3. Agent merges into config cascade: **Beacon > Agent's existing config**

### 3. API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/config` | Get all beacon config overrides |
| GET | `/config/:key` | Get specific config value |
| POST | `/config` | Set a config override |
| PUT | `/config/:key` | Update config override |
| DELETE | `/config/:key` | Remove config override |
| POST | `/config/sync` | Sync to coordinator (if swarm config) |

### 4. Request/Response Types

```typescript
interface BeaconConfigEntry {
  key: string;
  value: string; // JSON
  scope: "local" | "swarm";
  createdAt: number;
  updatedAt: number;
}

interface CreateConfigRequest {
  key: string;
  value: string; // JSON
  scope?: "local" | "swarm"; // default: "local"
}

interface ConfigSyncResponse {
  synced: number;
}
```

### 5. Agent Integration

When agent connects via swarm plugin:
1. Fetch beacon config: `GET /config`
2. Merge into agent config (beacon values override agent values)
3. Log/notify agent of config changes

Example merge:
```typescript
function mergeBeaconConfig(agentConfig: Config, beaconConfig: Record<string, unknown>): Config {
  return {
    ...agentConfig,
    ...beaconConfig,  // Beacon wins for same keys
  };
}
```

## Implementation Plan

### Step 1: Database (db.ts)
- Add `beacon_config` table schema
- Add CRUD functions:
  - `createBeaconConfig(key, value, scope?)`
  - `getBeaconConfig(key)`
  - `listBeaconConfig()`
  - `updateBeaconConfig(key, value)`
  - `deleteBeaconConfig(key)`

### Step 2: Types (types.ts)
- Add `BeaconConfigEntry`, `CreateConfigRequest` types

### Step 3: Routes (routes.ts)
- Add REST endpoints for config CRUD

### Step 4: Agent-Side (swarm plugin)
- On connect, fetch `/config`
- Merge into runtime config
- Provide a way to notify the agent of config changes

## Priority

**High Priority** because:
- Needed for beacon to control model selection across agents
- Enables environment-specific configuration
- Foundation for swarm-wide coordination

## Future (Phase 3)

- Coordinator can push config to all beacons
- Beacon can propagate config to all connected agents in real-time