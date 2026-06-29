---
key: cross-beacon-messaging-implementation
tags:
  - implementation
  - messaging
  - coordinator
  - beacon
  - planning
created: 2026-06-28T01:37:05.438Z
updated: 2026-06-28T01:37:05.438Z
---

# Cross-Beacon Messaging Implementation Plan

## Problem Statement

Current Phase 2 messaging works only for agents connected to the **same beacon**. Agents on different beacons cannot communicate.

## Architecture Overview

```
Agent A (Beacon 1)                    Agent B (Beacon 2)
      │                                     │
      ▼                                     │
POST /messages                            │
(toAgentId: "agent-B")                     │
      │                                     │
      ▼                                     │
Beacon 1 ──────► Coordinator ◄────── Beacon 2
      │  (relay)       │         (deliver)
      │                │
      ▼                ▼
Detects agent-B    Looks up beacon
not local          for agent-B
      │                │
      ▼                ▼
POST /messages/relay              POST /messages
{toAgentId, body}     ──────────► {fromAgentId, body}
```

## Implementation Components

### 1. Database Changes (Coordinator)

**New table: `agent_locations`**

```sql
CREATE TABLE agent_locations (
  agent_id TEXT PRIMARY KEY,
  beacon_id TEXT NOT NULL,
  persona_id TEXT,
  connected_at INTEGER NOT NULL,
  last_heartbeat INTEGER NOT NULL
);

CREATE INDEX idx_agent_locations_beacon ON agent_locations(beacon_id);
```

Purpose: Track which beacon each agent is currently connected to.

### 2. Coordinator Routes

#### 2.1 Register Agent Location

```
POST /agents/location
Body: { agentId: string, beaconId: string, personaId?: string }

Response: { success: true }
```

Called by beacon when agent connects (via existing `/sync/sessions/register` or new endpoint).

#### 2.2 Update Heartbeat

```
POST /agents/location/:agentId/heartbeat
Body: { beaconId: string }

Response: { success: true }
```

Called by beacon periodically to keep agent location fresh.

#### 2.3 Unregister Agent Location

```
DELETE /agents/location/:agentId
Body: { beaconId: string }

Response: { success: true }
```

Called by beacon when agent disconnects.

#### 2.4 Get Agent Location

```
GET /agents/location/:agentId

Response: { agentId, beaconId, personaId, connectedAt } or 404
```

Lookup endpoint for other beacons to find where an agent is.

#### 2.5 List Agents by Beacon

```
GET /agents/location?beaconId=:id

Response: [{ agentId, beaconId, personaId, connectedAt }, ...]
```

For beacon monitoring and admin.

#### 2.6 Message Relay (Main Feature)

```
POST /messages/relay
Body: {
  fromBeaconId: string,   // beacon sending the message
  fromAgentId: string,   // agent sending (for attribution)
  toAgentId: string,      // recipient agent ID
  body: string,           // message payload (JSON string)
}

Response: { success: true, messageId: string }
          or { error: "Agent not found", code: 404 }
          or { error: "Target beacon not connected", code: 503 }
```

Flow:

1. Validate request
2. Look up `toAgentId` in `agent_locations` table
3. Get target beacon's host/port from `beacons` table
4. Forward message to target beacon's `/messages` endpoint
5. Return result

### 3. Beacon Changes

#### 3.1 Accept External Messages

Update existing `POST /messages` to accept `fromBeaconId`:

```typescript
// New field in CreateMessageRequest
interface CreateMessageRequest {
  fromAgentId: string;
  fromBeaconId?: string; // NEW: for cross-beacon messages
  toAgentId?: string;
  toChannel?: string;
  body: string;
}
```

When `fromBeaconId` is present:

- Don't require `fromAgentId` to be registered locally
- Store message with `fromBeaconId` attribution
- Deliver normally to local recipient

#### 3.2 Coordinator Client Updates

Add methods to `coordinator-client.ts`:

```typescript
// Register agent location
registerAgentLocation(agentId: string, beaconId: string, personaId?: string): Promise<void>

// Update heartbeat
heartbeatAgentLocation(agentId: string, beaconId: string): Promise<void>

// Unregister agent location
unregisterAgentLocation(agentId: string, beaconId: string): Promise<void>

// Send message via relay
relayMessage(toAgentId: string, fromAgentId: string, body: string): Promise<{ messageId: string }>
```

#### 3.3 Update Beacon Routes

When agent connects (`POST /agents`):

```typescript
// Register with coordinator
const client = getCoordinatorClient();
if (client) {
  client.registerAgentLocation(agentId, beaconId, personaId).catch(...)
}
```

When agent disconnects (`DELETE /agents/:id`):

```typescript
// Unregister from coordinator
if (client) {
  client.unregisterAgentLocation(agentId, beaconId).catch(...)
}
```

When sending message to remote agent:

```typescript
// In POST /messages handler
const recipientBeacon = db.getAgentBeacon(toAgentId); // NEW: lookup
if (recipientBeacon && recipientBeacon.id !== localBeaconId) {
  // Send via coordinator relay
  const client = getCoordinatorClient();
  if (client) {
    return client.relayMessage(toAgentId, fromAgentId, body);
  }
}
```

### 4. Database Helper (Beacon)

New function in `drone-beacon/src/db.ts`:

```typescript
function getAgentBeacon(agentId: string): Beacon | undefined {
  // Query coordinator for agent location (or cache locally)
}
```

Or use coordinator client directly.

## File Changes Summary

| File                                          | Change                                                  |
| --------------------------------------------- | ------------------------------------------------------- |
| `drone-coordinator/src/db.ts`                 | Add `agent_locations` table + CRUD functions            |
| `drone-coordinator/src/routes.ts`             | Add location and relay endpoints                        |
| `drone-coordinator/src/types.ts`              | Add `AgentLocation` type                                |
| `drone-coordinator/src/coordinator-client.ts` | Add location/relay methods (called by beacon)           |
| `drone-beacon/src/types.ts`                   | Add `fromBeaconId` to `CreateMessageRequest`            |
| `drone-beacon/src/routes.ts`                  | Handle `fromBeaconId`, call coordinator on message send |
| `drone-beacon/src/coordinator-client.ts`      | Add location registration and message relay methods     |
| `drone-beacon/src/db.ts`                      | Optionally cache agent locations                        |

## Alternative: Direct Beacon-to-Beacon

Instead of routing through coordinator, beacons could communicate directly:

```
Agent A → Beacon 1 → Beacon 2 → Agent B
```

Pros:

- Lower latency
- Less load on coordinator

Cons:

- Requires each beacon to know about other beacons
- More complex connection management
- No coordinator oversight/logging

**Recommendation:** Start with coordinator relay (this plan). Direct beacon-to-beacon can be a future optimization.

## Testing Plan

1. **Unit tests** for each new DB function
2. **Integration tests**:
   - Agent A on Beacon 1 sends to Agent B on Beacon 2
   - Verify message delivered
   - Verify coordinator relay log
3. **Load test**: Many agents, many beacons

## Success Criteria

1. ✅ Agent on Beacon 1 can send message to agent on Beacon 2
2. ✅ Messages delivered in real-time (WS push) or stored for polling
3. ✅ Coordinator tracks all agent locations
4. ✅ Works with multiple beacons on different hosts
5. ✅ Graceful degradation if coordinator is down (messages queue locally)

## Priority

**Medium** - Not blocking Phase 3 completion, but needed for full swarm functionality.

After Phase 3.5 (Web UI) would be a good time to implement this.
