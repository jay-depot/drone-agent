---
key: cross-beacon-messaging-plan
tags:
  - planning
  - messaging
  - coordinator
  - beacon
created: 2026-06-28T01:36:43.363Z
updated: 2026-06-28T01:36:43.363Z
---

# Cross-Beacon Messaging Implementation Plan

## Overview

Enable agents connected to different beacons to communicate via the coordinator as a relay hub.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Coordinator                            │
│  ┌─────────────────┐  ┌──────────────────────────────────┐  │
│  │ Agent Registry  │  │ Message Relay                   │  │
│  │ (agent→beacon)  │  │                                 │  │
│  │                 │  │ POST /messages/relay             │  │
│  │ GET /agents/:id │  │ GET /agents/:id/messages        │  │
│  │                 │  │                                 │  │
│  └────────┬────────┘  └────────────┬───────────────────┘  │
│           │                         │                       │
└───────────┼─────────────────────────┼───────────────────────┘
            │                         │
   ┌────────┴────────┐      ┌────────┴────────┐
   │    Beacon 1     │      │    Beacon 2    │
   │                 │      │                 │
   │ Agent A ────────┼──────┼───────► Agent B │
   │                 │      │                 │
   └─────────────────┘      └─────────────────┘
```

## Database Changes

### Coordinator (`db.ts`)

Add new table:

```sql
-- Track agent locations across all beacons
CREATE TABLE IF NOT EXISTS swarm_agents (
  agent_id TEXT PRIMARY KEY,
  beacon_id TEXT NOT NULL,
  persona_id TEXT,
  connected_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_swarm_agents_beacon ON swarm_agents(beacon_id);
```

Add functions:
- `registerSwarmAgent(agentId, beaconId, personaId?)`
- `getSwarmAgent(agentId)` → returns agent location
- `updateSwarmAgentHeartbeat(agentId)`
- `unregisterSwarmAgent(agentId)`
- `listSwarmAgentsByBeacon(beaconId)`

### Beacon (`db.ts`) - No changes needed

The existing `messages` table already supports the schema needed.

---

## API Changes

### Coordinator (`routes.ts`)

#### New Endpoints:

**1. Agent Location Registry**

```typescript
// Register agent with coordinator
POST /agents/register
Body: { 
  agentId: string, 
  beaconId: string, 
  personaId?: string 
}
Response: { success: true, agentId, beaconId }

// Get agent location
GET /agents/:agentId
Response: { 
  agentId, 
  beaconId, 
  beaconHost, 
  beaconPort, 
  personaId?, 
  status, 
  connectedAt 
}

// Update heartbeat
POST /agents/:agentId/heartbeat
Response: { success: true }

// Unregister agent
DELETE /agents/:agentId
Response: { success: true }

// List agents on a beacon
GET /beacons/:beaconId/agents
Response: [{ agentId, personaId, connectedAt, status }]
```

**2. Message Relay**

```typescript
// Relay message to agent on (possibly) different beacon
POST /messages/relay
Body: { 
  fromBeaconId: string,
  fromAgentId: string, 
  toAgentId: string, 
  body: string,
  toChannel?: string  // optional channel broadcast
}
Response: { 
  success: boolean, 
  delivered: boolean,  // true if recipient online
  messageId?: string    // if stored for later delivery
}

// Get messages for an agent (offline retrieval)
GET /agents/:agentId/messages
Query: ?limit=50&offset=0
Response: [{ id, fromAgentId, body, createdAt, delivered }]
```

**3. Channel Broadcast (via coordinator)**

```typescript
// Broadcast to channel across all beacons
POST /messages/broadcast
Body: { 
  fromAgentId: string,
  channel: string, 
  body: string 
}
Response: { success: true, deliveredCount: number }
```

---

### Beacon (`routes.ts`)

**Minimal changes** - existing `/messages` endpoint works, but needs to handle relay case:

```typescript
// Modify POST /messages to accept fromBeaconId
POST /messages
Body: { 
  fromAgentId: string, 
  toAgentId?: string, 
  toChannel?: string,
  body: string,
  fromBeaconId?: string  // NEW: for relay from coordinator
}
```

When `fromBeaconId` is present, the beacon knows this is a relayed message and should:
1. Not require the sender to be a local agent
2. Still deliver to local recipient(s)

---

## Client Changes

### Beacon → Coordinator Client (`coordinator-client.ts`)

Add methods:

```typescript
// Register this beacon's agent with coordinator
async registerSwarmAgent(
  agentId: string, 
  beaconId: string, 
  personaId?: string
): Promise<void>

// Update heartbeat
async updateSwarmAgentHeartbeat(agentId: string): Promise<void>

// Unregister agent
async unregisterSwarmAgent(agentId: string): Promise<void>

// Relay message to agent on another beacon
async relayMessage(
  toAgentId: string,
  fromAgentId: string,
  body: string
): Promise<{ success: boolean; delivered: boolean }>

// Broadcast to channel across all beacons
async broadcastToChannel(
  channel: string,
  fromAgentId: string,
  body: string
): Promise<{ success: boolean; deliveredCount: number }>
```

---

## Message Flow

### Direct Agent-to-Agent (Cross-Beacon)

```
1. Agent A (Beacon 1) wants to message Agent B
   → POST /messages { toAgentId: "agent-B", body: "...", fromAgentId: "agent-A" }

2. Beacon 1 checks: is Agent B local?
   → Query: db.getAgent("agent-B") → NOT FOUND

3. Beacon 1 has non-local recipient
   → Call coordinatorClient.relayMessage("agent-B", "agent-A", "...")

4. Coordinator receives relay request
   → Look up: getSwarmAgent("agent-B") → { beaconId: "beacon-2", ... }

5. Coordinator forwards to Beacon 2
   → POST http://beacon-2:3457/messages { 
        fromAgentId: "agent-A", 
        toAgentId: "agent-B", 
        body: "...",
        fromBeaconId: "beacon-1"
      }

6. Beacon 2 delivers to Agent B (WS push or store in DB)
   → If Agent B connected: wsServer.sendToAgent("agent-B", {...})
   → Else: store in DB for polling

7. Coordinator returns to Beacon 1: { success: true, delivered: true/false }
8. Beacon 1 returns to Agent A: message sent
```

### Channel Broadcast (Cross-Beacon)

```
1. Agent A subscribes to channel "review" on Beacon 1
2. Agent B subscribes to channel "review" on Beacon 2
3. Agent A broadcasts to channel "review"
   → POST /messages { toChannel: "review", body: "...", fromAgentId: "agent-A" }

4. Beacon 1 delivers to local subscribers
5. Beacon 1 calls coordinatorClient.broadcastToChannel("review", "agent-A", "...")

6. Coordinator broadcasts to ALL connected beacons
   → POST http://beacon-2:3457/messages { toChannel: "review", body: "..." }

7. Beacon 2 delivers to local subscribers (Agent B)
```

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Recipient offline | Store in beacon's `messages` table, deliver on next connect |
| Unknown recipient | Return 404: "Agent not found" |
| Target beacon offline | Coordinator returns error: "Target beacon unavailable" |
| Coordinator offline | Beacon queues messages, retries on reconnect |
| Message size limit | Reject messages > 1MB (configurable) |
| Circular relay | Beacon detects `fromBeaconId === self` and rejects |

---

## Security Considerations

1. **Beacon Authentication**: Only registered beacons can use relay (already enforced via trust system)
2. **Agent Verification**: Messages must come from registered agents (enforced at beacon level)
3. **Local-only restriction**: WebSocket remains local-only per Phase 2 design
4. **Message validation**: Sanitize message body (prevent injection)

---

## Implementation Order

### Phase 1: Core Infrastructure
1. Add `swarm_agents` table to coordinator DB
2. Add registry API endpoints (`/agents/register`, `/agents/:id`, etc.)
3. Add beacon client methods

### Phase 2: Message Relay
4. Add `/messages/relay` endpoint to coordinator
5. Modify beacon `/messages` to accept `fromBeaconId`
6. Implement relay flow in beacon client

### Phase 3: Polish
7. Add channel broadcast via coordinator
8. Add offline message retrieval (`GET /agents/:id/messages`)
9. Error handling and retries

---

## Testing Plan

1. **Unit tests**: Database functions, message relay logic
2. **Integration tests**: 
   - Two beacons + coordinator, message relay
   - Channel broadcast across beacons
3. **E2E**: Full workflow: spawn agent on Beacon 1, spawn agent on Beacon 2, send messages between them

---

## Files to Modify

| File | Changes |
|------|---------|
| `drone-coordinator/src/db.ts` | Add `swarm_agents` table and functions |
| `drone-coordinator/src/routes.ts` | Add agent registry + message relay endpoints |
| `drone-coordinator/src/types.ts` | Add types for new endpoints |
| `drone-beacon/src/coordinator-client.ts` | Add relay methods |
| `drone-beacon/src/routes.ts` | Modify `/messages` to accept `fromBeaconId` |
| `drone-beacon/src/ws-server.ts` | May need minor adjustments |

---

## Estimated Effort

- **Phase 1 (Core)**: ~2 hours
- **Phase 2 (Relay)**: ~2 hours  
- **Phase 3 (Polish)**: ~1 hour
- **Testing**: ~2 hours

**Total**: ~7 hours