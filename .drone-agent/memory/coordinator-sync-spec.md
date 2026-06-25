---
key: coordinator-sync-spec
tags:
  - spec
  - coordinator
  - sync
  - beacon
  - sessions
  - knowledge
created: 2026-06-25T04:34:22.406Z
updated: 2026-06-25T04:34:22.406Z
---

# Coordinator Sync Specification

## Overview

This spec covers two high-priority features:

1. **Sync Knowledge from Coordinator** (push/pull)
2. **Push Sessions to Coordinator on Agent End**

## Problem Statement

Currently:

- Beacons can **pull** personas/skills from coordinator on startup
- No mechanism to push local knowledge to coordinator
- Coordinator has no visibility into individual agent sessions within beacons
- One-way sync limits the utility of the swarm architecture

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Coordinator (Master)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ personas    │  │ skills      │  │ beacon_sessions     │ │
│  │ (master)   │  │ (master)    │  │ (aggregated)        │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
         ▲ push (local changes)     ▲ push (session events)
         │                          │
         │ pull (periodic/webhook) │
         │                          │
┌────────┴──────────────────────────────┴──────────────┐
│                      Beacon                            │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────┐  │
│  │ local       │  │ coordinator │  │ agent_sessions│  │
│  │ personas   │  │ personas    │  │ (tracked)     │  │
│  │ skills     │  │ skills      │  └───────────────┘  │
│  └─────────────┘  └─────────────┘                    │
└─────────────────────────────────────────────────────┘
```

---

## Feature 1: Sync Knowledge from Coordinator

### 1.1 Pull Knowledge (Existing, Enhance)

**Current**: Beacon pulls personas/skills from coordinator on startup.

**Enhancement**: Add periodic sync or webhook-based push.

#### Coordinator Changes

- Add optional `beaconId` parameter to `/personas` and `/skills` endpoints
- Return only items modified since last sync (for efficiency)

#### Beacon Changes

```typescript
// coordinator-client.ts additions
interface KnowledgeSyncOptions {
  since?: number; // timestamp for incremental sync
  full?: boolean; // force full sync
}

interface CoordinatorClient {
  // ... existing methods ...

  pullPersonas(options?: KnowledgeSyncOptions): Promise<Persona[]>;
  pullSkills(options?: KnowledgeSyncOptions): Promise<Skill[]>;
}
```

**Sync Strategy**:

1. Initial full sync on beacon startup
2. Incremental sync every N minutes (configurable)
3. Optional: Coordinator webhook POSTs to beacon on persona/skill change

### 1.2 Push Knowledge (New)

**Use Case**: Beacon has locally-created personas/skills that should be available to other beacons via the coordinator.

#### Beacon Changes

```typescript
// coordinator-client.ts additions
interface CoordinatorClient {
  // ... existing methods ...

  pushPersona(persona: Persona): Promise<void>;
  pushSkill(skill: Skill): Promise<void>;
  deletePersona(id: string): Promise<void>;
  deleteSkill(id: string): Promise<void>;
}
```

#### Routes Changes

- On `POST/PUT/DELETE /personas` and `/skills` with `scope: "local"`, automatically push to coordinator
- Add config option to enable/disable auto-push

#### Sync Logic

```
Local persona created
    │
    ▼
Is coordinator configured? ──No──▶ Skip sync
    │
   Yes
    │
    ▼
Push to coordinator
    │
    ▼
Success? ──No──▶ Log warning, continue
    │
   Yes
    │
    ▼
Mark as "synced" in local DB (optional)
```

---

## Feature 2: Push Sessions to Coordinator

### 2.1 Session Registration

**Current**: Beacon registers itself with coordinator on startup.

**Enhancement**: Also report active agent sessions.

#### Coordinator Changes

```sql
-- New table: beacon_sessions
CREATE TABLE beacon_sessions (
  id TEXT PRIMARY KEY,
  beacon_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  persona_id TEXT,
  connected_at INTEGER NOT NULL,
  disconnected_at INTEGER,
  duration_ms INTEGER,  -- calculated on disconnect
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  FOREIGN KEY (beacon_id) REFERENCES beacons(id)
);

CREATE INDEX idx_beacon_sessions_beacon ON beacon_sessions(beacon_id);
CREATE INDEX idx_beacon_sessions_agent ON beacon_sessions(agent_id);
```

#### Coordinator Routes

| Method | Endpoint                         | Description                       |
| ------ | -------------------------------- | --------------------------------- |
| POST   | `/beacons/:id/sessions`          | Register a new agent session      |
| GET    | `/beacons/:id/sessions`          | List sessions for a beacon        |
| GET    | `/beacons/:id/sessions/:agentId` | Get specific session              |
| DELETE | `/beacons/:id/sessions/:agentId` | End a session (mark disconnected) |

#### Beacon Changes

```typescript
// coordinator-client.ts additions
interface SessionInfo {
  id: string;
  beaconId: string;
  agentId: string;
  personaId: string | null;
  connectedAt: number;
}

interface CoordinatorClient {
  // ... existing methods ...

  registerSession(session: SessionInfo): Promise<void>;
  endSession(
    agentId: string,
    disconnectedAt: number,
    durationMs: number
  ): Promise<void>;
}
```

### 2.2 Session Lifecycle

```
Agent connects to Beacon
    │
    ▼
Beacon registers session in local DB
    │
    ▼
Is coordinator configured? ──No──▶ Skip sync
    │
   Yes
    │
    ▼
POST /beacons/:id/sessions (optional, on connect)
    │
    ▼
Agent disconnects from Beacon
    │
    ▼
Beacon unregisters agent (local cleanup)
    │
    ▼
Is coordinator configured? ──No──▶ Skip sync
    │
   Yes
    │
    ▼
DELETE /beacons/:id/sessions/:agentId (with end time, duration)
```

### 2.3 Configuration

| Config Key                 | Type    | Default | Description                              |
| -------------------------- | ------- | ------- | ---------------------------------------- |
| `sync.pushKnowledge`       | boolean | true    | Auto-push local knowledge to coordinator |
| `sync.pullIntervalMinutes` | number  | 5       | How often to pull from coordinator       |
| `sync.pushSessions`        | boolean | true    | Push session events to coordinator       |

---

## Implementation Checklist

### Phase 1: Coordinator Changes

- [ ] Add `beacon_sessions` table to db.ts
- [ ] Add session CRUD functions to db.ts
- [ ] Add session routes to routes.ts
- [ ] Add session endpoints to coordinator-client (beacon side)

### Phase 2: Beacon Session Sync

- [ ] Wire up session registration on agent connect
- [ ] Wire up session end on agent disconnect
- [ ] Add config options

### Phase 3: Knowledge Sync (Push)

- [ ] Add push methods to coordinator-client
- [ ] Wire up push on local persona create/update/delete
- [ ] Wire up push on local skill create/update/delete
- [ ] Add config option

### Phase 4: Knowledge Sync (Pull)

- [ ] Add pull methods to coordinator-client
- [ ] Add periodic sync or webhook support
- [ ] Add config option

---

## Edge Cases

1. **Coordinator offline**: Buffer pushes, retry on reconnect
2. **Duplicate sync**: Use timestamps/versions to avoid overwriting newer data
3. **Session already exists**: Upsert on reconnect
4. **Beacon restart**: Re-register all active sessions on startup
5. **Partial sync failure**: Log and continue, don't block local operations

---

## Testing

1. Unit tests for session sync logic
2. Integration: Beacon → Coordinator session flow
3. Integration: Local persona push → Coordinator
4. Integration: Coordinator pull → Beacon
5. Edge case: Coordinator offline during sync

---

_Created: 2026-06-26_
_Last updated: 2026-06-26_
