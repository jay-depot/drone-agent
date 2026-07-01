---
key: db-refactoring-phase-2
tags:
  - refactoring
  - architecture
  - duplication
  - drone-swarm-common
  - deferred
created: 2026-07-01T01:12:33.282Z
updated: 2026-07-01T01:12:33.282Z
---

# 🗄️ Deferred Phase 2: Extract Shared DB Operations into `drone-swarm-common`

## Context

This is a follow-up to the `drone-swarm-common` package extraction (Phase 1: wiki-storage + TLS). Phase 2 extracts the duplicated database schema definitions and CRUD operations shared between `drone-beacon` and `drone-coordinator`.

## What's Duplicated

Both `drone-beacon/src/db.ts` (1,295 lines) and `drone-coordinator/src/db.ts` (1,518 lines) contain nearly identical code for these tables:

| Table        | Beacon Schema | Coordinator Schema | CRUD Similarity                                                                      |
| ------------ | ------------- | ------------------ | ------------------------------------------------------------------------------------ |
| `personas`   | ✅            | ✅                 | ~95% (beacon has `scope` param, `listLocalPersonas`, `upsertPersonaFromCoordinator`) |
| `skills`     | ✅            | ✅                 | ~95% (beacon has `scope` param, `listLocalSkills`, `upsertSkillFromCoordinator`)     |
| `insights`   | ✅            | ✅                 | ~100% identical                                                                      |
| `principles` | ✅            | ✅                 | ~100% identical                                                                      |
| `wiki_pages` | ✅            | ✅                 | ~100% identical (beacon has this in db.ts, coordinator does too)                     |

## Unique Tables (NOT to extract)

**Beacon-only:** `agent_sessions`, `memory`, `messages`, `spawns`, `beacon_config`, `event_log`, `knowledge_cache`

**Coordinator-only:** `beacons`, `beacon_trust`, `beacon_sessions`, `knowledge`, `swarm_sessions`, `swarm_events`, `swarm_events_fts`, `agent_locations`, `web_token`

## Design Notes

- The shared CRUD functions should accept a `Database` instance (from better-sqlite3) rather than using a global `db` variable
- Beacon's extra `scope` parameter on `createPersona`/`createSkill` can be handled by a default parameter
- Beacon's `listLocalPersonas`/`listLocalSkills` and `upsertPersonaFromCoordinator`/`upsertSkillFromCoordinator` are beacon-specific and should stay in beacon's db.ts
- The shared module should export both schema DDL strings and CRUD functions
- Logger setter pattern (same as Phase 1) for logging

## Implementation Strategy

1. Create `drone-swarm-common/src/db/` directory
2. Extract shared schema definitions into `drone-swarm-common/src/db/schema.ts`
3. Extract shared CRUD operations into separate files per domain:
   - `drone-swarm-common/src/db/personas.ts`
   - `drone-swarm-common/src/db/skills.ts`
   - `drone-swarm-common/src/db/insights.ts`
   - `drone-swarm-common/src/db/principles.ts`
   - `drone-swarm-common/src/db/wiki-pages.ts`
4. Export all from `drone-swarm-common/src/db/index.ts`
5. Update beacon's `db.ts` to import shared operations and keep only beacon-specific code
6. Update coordinator's `db.ts` to import shared operations and keep only coordinator-specific code
7. Update tests

## Risk Assessment

- **Medium complexity**: The CRUD functions have minor behavioral differences (scope parameter, default scope values) that need careful parameterization
- **Low risk**: The code is already tested in both packages
- **Breaking change**: Internal refactoring only — no public API changes
