---
key: phase-2-todo
tags:
  - phase2
  - beacon
  - todo
  - swarm
created: 2026-06-24T01:57:59.883Z
updated: 2026-06-25T01:18:59.123Z
---

# Phase 2 Todo List

## Beacon Memory Store Implementation

- [x] 1. Add memory types to types.ts
- [x] 2. Add memory table schema and CRUD functions to db.ts
- [x] 3. Add memory routes to routes.ts
- [x] 4. Implement TTL cleanup (lazy or periodic)

## Integration & Testing

- [ ] 5. Integration test: Run beacon + agent with swarm plugin

## Documentation

- [x] 6. Write README for drone-beacon
- [x] 7. Document API endpoints

## Additional Features (Phase 2 scope)

- [ ] 8. Inter-agent messaging (communication channel)
  - Note: Memory store with namespace support provides basic kv, need dedicated messaging
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
- [ ] 10. Beacon-level config override

## What's Still Needed

### High Priority
- [ ] Inter-agent messaging - Memory store provides KV but no pub/sub or message queue
- [ ] Integration test - beacon + agent with swarm plugin

### Medium Priority
- [ ] Beacon-level config override - Allow beacon to override project/user config
- [ ] Sync knowledge from coordinator (push/pull)
- [ ] Push sessions to coordinator on agent end

### Lower Priority
- [ ] Event log (append-only log for agent events)
- [ ] Auto-download of beacon binary for agent

---

*Last updated: 2026-06-25*
*Checked against actual implementation in drone-beacon/src/*