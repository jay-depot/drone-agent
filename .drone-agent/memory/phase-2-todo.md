---
key: phase-2-todo
tags:
  - phase2
  - beacon
  - todo
  - swarm
created: 2026-06-24T01:57:59.883Z
updated: 2026-06-25T04:55:43.303Z
---

# Phase 2 Todo List

## Beacon Memory Store Implementation

- [x] 1. Add memory types to types.ts
- [x] 2. Add memory table schema and CRUD functions to db.ts
- [x] 3. Add memory routes to routes.ts
- [x] 4. Implement TTL cleanup (lazy or periodic)

## Integration & Testing

- [x] 5. Integration test: Run beacon + agent with swarm plugin
  - Note: Automatic smoke test in Docker covers this

## Documentation

- [x] 6. Write README for drone-beacon
- [x] 7. Document API endpoints

## Additional Features (Phase 2 scope)

- [x] 8. Inter-agent messaging (communication channel)
  - SPEC: Memory: inter-agent-messaging-spec
  - IMPLEMENTED:
    - [x] Add messages table to db.ts
    - [x] Add message CRUD functions (createMessage, getMessage, listMessagesForAgent, listMessagesByChannel, markMessageDelivered, cleanupOldMessages)
    - [x] Create WebSocket server (ws-server.ts) with:
      - /ws endpoint for real-time messaging
      - Direct messages (agent → agent)
      - Channel broadcast
      - Subscribe/unsubscribe to channels
      - Keepalive ping/pong
    - [x] Add message REST routes to routes.ts
    - [x] Message cleanup (24h retention after delivery)
  - Phase 3 will add cross-beacon via coordinator
- [x] 9. Agent spawn execution
  - [x] SPEC: Agent spawn spec created (memory: agent-spawn-spec)
  - [x] IMPLEMENTED: Core spawn functionality (Phase 1)
    - [x] Add spawn types to types.ts
    - [x] Add spawns table to db.ts
    - [x] Create spawner.ts with spawn logic
    - [x] Add spawn routes to routes.ts
    - [x] Add CLI args to index.ts
  - [x] IMPLEMENTED: Monitoring & management (Phase 2)
    - [x] GET /spawn/:id endpoint
    - [x] GET /spawn list endpoint
    - [x] DELETE /spawn/:id (terminate)
    - [x] Track agent exit and update status
  - [ ] TODO: Integration testing (Phase 3)
- [x] 10. Beacon-level config override
  - IMPLEMENTED:
    - [x] Add beacon_config table to db.ts
    - [x] Add CRUD functions (createBeaconConfig, getBeaconConfig, listBeaconConfig, updateBeaconConfig, deleteBeaconConfig)
    - [x] Add REST routes: GET/POST /config, GET/PUT/DELETE /config/:key

## What's Still Needed

### High Priority
- [x] Sync knowledge from coordinator (push/pull)
  - IMPLEMENTED:
    - [x] Coordinator: beacon_sessions table + endpoints
    - [x] Beacon: Session sync on connect/disconnect (with duration)
    - [x] Beacon: Auto-push local personas on create/update/delete
    - [x] Beacon: Auto-push local skills on create/update/delete
    - [x] POST /sync endpoint for manual pull from coordinator
    - [x] Periodic auto-pull with configurable interval (--sync-interval-minutes, default 5min)
    - [x] Initial sync on beacon startup
- [x] Push sessions to coordinator on agent end
  - IMPLEMENTED:
    - [x] Coordinator: beacon_sessions table with duration tracking
    - [x] Beacon: registerSession() on agent connect
    - [x] Beacon: endSession() on agent disconnect with connectedAt timestamp

### Medium Priority
- [x] Event log (append-only log for agent events)
  - IMPLEMENTED:
    - [x] Add event_log table with indexes
    - [x] Add CRUD functions (createEventLog, getEventLog, listEventLogs, cleanupOldEventLogs)
    - [x] Add REST routes: GET /events, GET /events/:id
    - [x] Add event logging for agent connect/disconnect and persona created
- [x] Agent-side WebSocket client in swarm plugin
  - IMPLEMENTED in drone-agent/src/plugins/swarm/index.ts:
    - [x] WebSocket connection with reconnection (exponential backoff)
    - [x] Message queue for offline delivery
    - [x] Channel subscribe/unsubscribe
    - [x] swarm_message tool with actions: send, subscribe, unsubscribe, get_messages
    - [x] Heartbeat for session maintenance

### Moved to Future Phase
- [ ] Auto-download of beacon binary for agent (moving to Phase X)

---

*Last updated: 2026-06-26*
*Checked against actual implementation in drone-beacon/src/*