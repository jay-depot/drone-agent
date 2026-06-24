---
key: phase-2-todo
tags:
  - phase2
  - beacon
  - todo
  - swarm
created: 2026-06-24T01:57:59.883Z
updated: 2026-06-24T06:31:41.275Z
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

- [ ] 6. Write README for drone-beacon
- [ ] 7. Document API endpoints

## Additional Features (Phase 2 scope)

- [ ] 8. Inter-agent messaging (communication channel)
- [ ] 9. Agent spawn execution
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

---

*Last updated: 2026-06-24*
*Item 9 spec: see memory `agent-spawn-spec`*