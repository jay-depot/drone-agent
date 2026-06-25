---
key: inter-agent-messaging-spec
tags:
  - messaging
  - beacon
  - phase2
  - spec
  - websocket
created: 2026-06-25T03:38:10.747Z
updated: 2026-06-25T03:38:10.747Z
---

# Inter-Agent Messaging Specification (Phase 2)

## Overview

Real-time message passing between agents on the same beacon using WebSockets.

## Architecture

```
┌─────────────────────────────────────────────┐
│              drone-beacon                    │
│                                             │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│  │ Agent A │◄──►│  WS     │◄──►│ Agent B │  │
│  │         │    │ Server  │    │         │  │
│  └─────────┘    └─────────┘    └─────────┘  │
│                     │                        │
│              ┌──────┴──────┐                 │
│              │ messages    │                 │
│              │ table       │                 │
│              └─────────────┘                 │
└─────────────────────────────────────────────┘
```

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT,           -- null if channel-based
  channel TEXT,               -- null if direct message
  body TEXT NOT NULL,         -- JSON string payload
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
```

## WebSocket Protocol

### Connection

- Path: `/ws` (upgrade from HTTP)
- Each agent connects with its `agentId` in the query string: `/ws?agentId=agent-xxx`
- Auth: Agent must be registered via `/agents` first (verified via session)

### Message Types (JSON)

**1. Send a message (client → server)**

```json
{
  "type": "message",
  "payload": {
    "toAgentId": "agent-xxx",
    "toChannel": "review-queue",
    "body": { "type": "task", "content": "review PR #42" }
  }
}
```

**2. Incoming message (server → client)**

```json
{
  "type": "message",
  "payload": {
    "id": "msg-uuid",
    "fromAgentId": "agent-yyy",
    "channel": null,
    "body": { "type": "task", "content": "review PR #42" },
    "receivedAt": 1750523400000
  }
}
```

**3. Acknowledge delivery (client → server)**

```json
{
  "type": "ack",
  "payload": { "messageId": "msg-uuid" }
}
```

**4. Ping/pong (keepalive)**

```json
{ "type": "ping" }
{ "type": "pong" }
```

## API Endpoints

### REST (for non-WebSocket clients or debugging)

| Method | Endpoint                     | Description                                 |
| ------ | ---------------------------- | ------------------------------------------- |
| POST   | `/messages`                  | Send a message (direct or channel)          |
| GET    | `/messages`                  | List messages for agent (unread by default) |
| GET    | `/messages/:id`              | Get single message                          |
| POST   | `/messages/:id/read`         | Mark message as read/delivered              |
| GET    | `/messages/channel/:channel` | List messages in a channel                  |

### WebSocket

| Event       | Direction       | Description           |
| ----------- | --------------- | --------------------- |
| `message`   | bidirectional   | Send/receive messages |
| `ack`       | client → server | Acknowledge receipt   |
| `ping/pong` | bidirectional   | Keepalive             |

## Message Flow

### Direct Message (A → B)

```
1. Agent A sends WebSocket message:
   { "type": "message", "payload": { "toAgentId": "agent-B", "body": {...} } }

2. Beacon stores in messages table with delivered=0

3. If Agent B is connected via WS:
   - Push message to Agent B immediately
   - Agent B acknowledges with { "type": "ack", "payload": { "messageId": "..." } }
   - Beacon marks delivered=1

4. If Agent B is NOT connected:
   - Message stays in table (delivered=0)
   - When Agent B connects, it fetches unread messages
   - Same delivery flow
```

### Channel Message (Broadcast)

```
1. Agent A sends to channel:
   { "type": "message", "payload": { "toChannel": "review-queue", "body": {...} } }

2. Beacon stores message (to_agent_id = null, channel = "review-queue")

3. For each connected agent in the channel (or all agents):
   - Push message to each connected client
   - Track delivery per-recipient
```

## Cleanup

- **Cleanup job**: Runs daily, deletes messages where:
  - `delivered = 1` AND `created_at < (now - 24 hours)`
- **On agent connect**: Also check for and deliver any missed messages

## Implementation Plan

### Step 1: Database (db.ts)

- Add `messages` table schema
- Add CRUD functions:
  - `createMessage(fromAgentId, toAgentId?, channel?, body)`
  - `getMessage(id)`
  - `listMessagesForAgent(agentId, unreadOnly?)`
  - `listMessagesByChannel(channel)`
  - `markMessageDelivered(id)`
  - `cleanupOldMessages(maxAgeHours)`

### Step 2: WebSocket Server (ws-server.ts)

- New file: Fastify WebSocket plugin
- Handle `/ws` upgrade request
- Maintain Map<agentId, WSConnection>
- Message routing: direct or channel
- Ping/pong keepalive (30s interval)

### Step 3: Routes (routes.ts)

- Add REST endpoints for message CRUD
- Integrate with existing agent registration

### Step 4: Agent-Side (swarm plugin)

- On agent init, connect to WebSocket
- On message received, queue for delivery to agent
- Provide message-polling tool or inject as system message

## Agent-Side Integration

The swarm plugin needs:

1. **WebSocket connection** on init
2. **Message queue** - buffer incoming messages
3. **Delivery mechanism** - either:
   - Tool: `get_messages()` - agent pulls when ready
   - Or: inject as system message at turn start

I'll suggest starting with a tool for explicit control.

## Future (Phase 3)

- **Cross-beacon messaging**: Messages go through coordinator
- **Coordinator routing**: Coordinator knows which beacon each agent is on
- **Federated channels**: Channels can span beacons

---

## Key Design Decisions

1. **WebSocket over SSE**: Real-time, bidirectional, easier long-term
2. **Keep messages 1 day after delivery**: Enough for retry, not forever
3. **Delivery acknowledgment**: Explicit ack ensures reliability
4. **Direct + Channel**: Both supported (direct for task delegation, channel for events)
5. **Phase 2 single beacon only**: Coordinator routing in Phase 3
