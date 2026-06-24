---
key: agent-spawn-spec
tags:
  - spec
  - beacon
  - spawn
  - phase2
  - design
created: 2026-06-24T06:06:34.444Z
updated: 2026-06-24T06:06:34.444Z
---

# Agent Spawn Execution Specification

## Overview

**Feature:** Agent spawn execution from beacon  
**Location:** `drone-beacon/src`  
**Phase:** Phase 2 (beacon) - item 9 of phase-2-todo

### Purpose

Enable the beacon to spawn new agent processes on demand. This is foundational for:
- **Phase 3**: Coordinator directing beacons to spawn agents
- **Phase 4**: Gateway spawning agents for chat conversations
- **Phase 5**: Distributed task routing across beacons

---

## Use Cases

### UC1: Manual Spawn via API
A user or system sends a spawn request to the beacon API. The beacon spawns an agent with a specified persona to handle a task.

### UC2: Coordinator-Directed Spawn
The coordinator sends a spawn request to a beacon (via beacon's API) to launch an agent for swarm-wide task execution.

### UC3: Gateway-Initiated Spawn
The gateway receives a chat message and spawns an agent via the beacon to handle the conversation.

### UC4: Scheduled/Background Spawn
Beacon could have internal triggers to spawn agents based on conditions (future: not in initial spec).

---

## API Design

### POST /spawn

**Request:**
```typescript
interface SpawnRequest {
  personaId?: string;        // Persona to load (optional)
  task?: string;            // Initial task/message for the agent
  config?: {
    model?: string;         // Model to use (e.g., "llama3")
    preamble?: string;     // Override persona's system prompt
    workingDir?: string;   // Working directory for the agent
    env?: Record<string, string>;  // Environment variables
  };
  spawnId?: string;         // Client-provided ID (optional, for tracking)
}
```

**Response (202 Accepted):**
```typescript
interface SpawnResponse {
  spawnId: string;          // Beacon-generated or client-provided ID
  agentId: string;          // The session ID the agent will use
  status: "spawning" | "running" | "failed";
  beaconUrl: string;        // Beacon URL for agent to connect to
  message?: string;        // Human-readable status
}
```

### GET /spawn/:spawnId

**Response:**
```typescript
interface SpawnStatusResponse {
  spawnId: string;
  agentId: string | null;
  status: "spawning" | "running" | "failed" | "terminated";
  createdAt: number;
  startedAt?: number;
  terminatedAt?: number;
  exitCode?: number;
  error?: string;
}
```

### GET /spawn

List all spawn requests (with optional filters).

### DELETE /spawn/:spawnId

Terminate a spawned agent (sends SIGTERM, then SIGKILL after timeout).

---

## Database Schema

### New Table: `spawns`

```sql
CREATE TABLE IF NOT EXISTS spawns (
  id TEXT PRIMARY KEY,           -- spawnId
  agent_id TEXT,                -- Agent session ID once registered
  persona_id TEXT,              -- Requested persona
  task TEXT,                    -- Initial task
  config_json TEXT,             -- JSON string of config
  status TEXT NOT NULL DEFAULT 'spawning',  -- spawning|running|failed|terminated
  error TEXT,                   -- Error message if failed
  created_at INTEGER NOT NULL,  -- Unix timestamp
  started_at INTEGER,           -- Unix timestamp when agent connected
  terminated_at INTEGER,        -- Unix timestamp when agent exited
  exit_code INTEGER             -- Exit code if terminated
);
```

### Indexes
```sql
CREATE INDEX IF NOT EXISTS idx_spawns_status ON spawns(status);
CREATE INDEX IF NOT EXISTS idx_spawns_agent_id ON spawns(agent_id);
```

---

## Spawn Flow

```
1. Client POST /spawn
         │
         ▼
2. Validate request (persona exists if provided)
         │
         ▼
3. Generate spawnId (UUID) if not provided
         │
         ▼
4. Insert spawn record (status: "spawning")
         │
         ▼
5. Spawn child process:
   drone-agent [options] --swarm --session-id <agentId> [--task "..."]
         │
         ├── On success (agent connects):
         │    6a. Update spawn record (status: "running", agentId, startedAt)
         │    6b. Return 202 with SpawnResponse
         │
         └── On failure:
              6c. Update spawn record (status: "failed", error)
              6d. Return 202 with SpawnResponse (status: "failed")
```

---

## Child Process Arguments

The spawned agent should receive arguments to connect to the beacon:

| Argument | Description | Example |
|----------|-------------|---------|
| `--swarm` | Enable swarm plugin | flag |
| `--session-id` | Unique session ID | `agent-uuid` |
| `--beacon-host` | Beacon hostname | `localhost` |
| `--beacon-port` | Beacon port | `3457` |
| `--persona` | Persona ID to load | `coder` |
| `--task` | Initial task/message | `"Fix the bug in..."` |
| `--model` | Model to use | `llama3` |
| `--working-dir` | Working directory | `/project` |

**Spawn command example:**
```bash
drone-agent --swarm --session-id agent-123 --beacon-host localhost --beacon-port 3457 --persona coder --task "Hello"
```

---

## Configuration

### CLI Arguments (drone-beacon)
```bash
drone-beacon --port 3457 --spawn-agent-path /usr/local/bin/drone-agent
```

| Argument | Default | Description |
|----------|---------|-------------|
| `--spawn-agent-path` | `drone-agent` | Path to drone-agent binary |
| `--spawn-timeout-ms` | `30000` | Timeout for agent to connect |
| `--max-concurrent-spawns` | `10` | Max parallel spawned agents |

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Invalid personaId | 400 Bad Request with error message |
| Spawn binary not found | 500, spawn record status: "failed", error: "binary not found" |
| Process exits immediately | Update spawn record with exit code, status: "failed" |
| Agent doesn't connect within timeout | Update status: "failed", error: "timeout" |
| Max concurrent spawns reached | 503 Service Unavailable |

---

## Security Considerations

1. **Spawn binary path**: Validate path is within expected directories
2. **Environment variables**: Sanitize user-provided env vars (no `=`, no newlines in keys)
3. **Working directory**: Validate path exists and is accessible
4. **Rate limiting**: Consider adding rate limits on spawn endpoint
5. **Authentication**: Future: require API key for spawn endpoint

---

## Implementation Tasks

### Phase 1: Core Spawn Functionality
- [ ] Add spawn types to `types.ts`
- [ ] Add `spawns` table to `db.ts`
- [ ] Create `spawner.ts` with spawn logic
- [ ] Add spawn routes to `routes.ts`
- [ ] Add CLI args to `index.ts`

### Phase 2: Monitoring & Management
- [ ] GET /spawn/:id endpoint
- [ ] GET /spawn list endpoint
- [ ] DELETE /spawn/:id (terminate)
- [ ] Track agent exit and update status

### Phase 3: Integration
- [ ] Integration test: spawn agent via API
- [ ] Integration test: spawned agent connects to beacon
- [ ] Integration test: terminate spawned agent

---

## Open Questions

1. **How does the agent know the initial task?**
   - Option A: Pass via CLI argument (`--task`)
   - Option B: Beacon stores task, agent fetches on connect via `/spawn/:id/task`
   - Decision: Pass via CLI for simplicity (Option A)

2. **Should spawned agents auto-terminate?**
   - Option A: Yes, after N minutes of inactivity
   - Option B: No, explicit termination only
   - Decision: Option B for now, can add TTL later

3. **How to pass config to agent?**
   - The swarm plugin already connects to beacon
   - Spawned agent loads persona from beacon automatically
   - Additional config passed via CLI arguments

---

## Related Files

| File | Changes |
|------|---------|
| `src/types.ts` | Add `SpawnRequest`, `SpawnResponse`, `SpawnStatus` |
| `src/db.ts` | Add `createSpawn`, `getSpawn`, `updateSpawn`, `listSpawns`, `deleteSpawn` |
| `src/spawner.ts` | **NEW** - Spawn process logic |
| `src/routes.ts` | Add `/spawn` routes |
| `src/index.ts` | Add CLI args for spawn config |
| `drone-agent/src/plugins/swarm/index.ts` | Add `--task` argument support |

---

## References

- Roadmap: `roadmap` (memory)
- Phase 2 TODO: `phase-2-todo` (memory)
- Phase 5 spawn routing: "Route to node with best model for task"