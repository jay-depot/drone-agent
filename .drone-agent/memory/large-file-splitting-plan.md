---
key: large-file-splitting-plan
tags:
  []
created: 2026-07-06T22:56:06.469Z
updated: 2026-07-06T23:31:27.225Z
---

# Plan: Split Large Files Across drone-agent — COMPLETED

## Summary
All 10 large files (1,100–2,100 lines each) have been split into smaller, focused modules. All 3 tiers completed successfully.

## Results

### Tier 1: swarm/index.ts (1,385 lines) → 10 modules
- `index.ts` (~100 lines) — barrel + factory wiring
- `context.ts` — SwarmContext interface + factory
- `config.ts` — SwarmConfig, BeaconConfigInjector, constants
- `providers.ts` — Persona/skill providers and writers
- `websocket.ts` — WebSocket client
- `tools-message.ts` — swarm_message tool
- `tools-wiki.ts` — 6 wiki tool definitions
- `tools-coordinator.ts` — 6 coordinator spawn/info tools
- `hooks.ts` — Lifecycle hooks + event buffer + storage engines
- `heartbeat.ts` — Heartbeat interval + shutdown

### Tier 2: beacon/db.ts (1,294) + coordinator/db.ts (1,707) → 28 entity files
- Shared CRUD helper in `drone-swarm-common/src/db-helpers.ts`
- Beacon: 12 entity files + init + barrel
- Coordinator: 14 entity files + init + barrel

### Tier 3a: LSP Plugin
- `tools.ts` (1,230) → `lsp/tools/` (7 files)
- `normalize.ts` (1,153) → `lsp/normalize/` (11 files)
- `server.ts` helpers → `lsp/server/helpers.ts`

### Tier 3b: self-improvement/index.ts (1,113 lines) → 7 modules + tools/
- constants, validation, paths, io, file-engine, capability, prompt-fragment, principles-fragment, state
- tools/ subdirectory with 7 tool files

### Tier 3c: migration-service.ts (1,145 lines) → 12 files
- types, helpers, paths, listing, beacon-client, frontmatter, backup, promote, demote, wiki, public-api, index

### Tier 3d: Test Files
- coordinator/test/routes.test.ts (2,096) → 11 route-specific test files
- agent/test/self-improvement.test.ts (1,607) → 7 focused test files

## Validation
- ✅ `pnpm typecheck` — zero errors
- ✅ `pnpm test` — 80 test files, 1,213 tests, all passing
- ✅ All existing imports updated to new module paths
- ✅ No functionality changes — pure structural refactoring

## Key Design Decisions
- **SwarmContext pattern**: Factory closure state bundled into a context object passed to module functions
- **Shared CRUD helpers**: Generic getRow/listRows/createRow/updateRow/deleteRow in drone-swarm-common
- **Tool factory pattern**: Each tool created via factory function receiving its dependencies
- **Barrel files**: Each module directory has an index.ts re-exporting all public symbols