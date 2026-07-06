---
key: review-state
tags:
  []
created: 2026-06-26T01:58:17.133Z
updated: 2026-07-06T22:03:45.163Z
---

# Code Review Summary - drone-agent

## Overall State: Growing — actively maintained, new packages added, tech debt accumulating

| Metric              | Previous (Jun 26) | Current (Jul 6)  | Delta    |
| ------------------- | ----------------- | ---------------- | -------- |
| Source files        | 155               | 294              | +139     |
| Total lines         | ~42,000           | 72,536           | +30,536  |
| Test files passing  | 65                | 65               | 0        |
| Tests passing       | 1,213             | 1,213            | 0        |
| TypeScript errors   | 0 (source)        | 5 (test mocks)   | +5       |
| Hints (unused code) | ~70               | ~70              | ~same    |
| Workspace packages  | 4                 | 8                | +4       |

---

## What Changed (New Since Last Scan)

### New Workspace Packages (+4)

| Package              | Description                                        | Files | Lines  |
| -------------------- | -------------------------------------------------- | ----- | ------ |
| **drone-gateway**    | Chat API integration layer for the drone swarm     | 9 src | 1,826  |
| **drone-swarm-common** | Shared utilities for beacon/coordinator           | 5 src | 1,083  |
| **drone-coordinator-ui** | Web UI for drone-coordinator (Vite + React)      | 20+   | 1,921  |
| **docker/**          | Docker-based test infrastructure (echo-llm, etc.)  | 5 src | 956    |

### Major Refactors

1. **drone-core/src/index.ts** — **Split from 1,269 → 224 lines** ✅ (was Priority 4)
   - Now a clean barrel re-export file
   - Implementation spread across 14 modular files (config-types, session-types, plugin-system, etc.)
   - Total drone-core: 2,426 lines across 17 files

2. **TUI tail region refactor** — Live pre-rendering with atomic commit
   - `tui/app.tsx`, `tui/types.ts`, `tui/components/` modified

3. **Conversation event streaming unified** — Single entry point through engine hooks
   - `conversation-service.ts`, `plugin-engine.ts`, `tui/app.tsx` changes

4. **Plugin-customizable tool render components** — TUI tail region now supports custom renderers

### Test Infrastructure

- **drone-beacon**: 7 test files (app-helper, coordinator-client, db, identity, routes, ws-server)
- **drone-coordinator**: 7 test files (app-helper, auth, db, knowledge, routes, storage)
- **drone-gateway**: 6 test files (coordinator-client, coordinator-spawn-backend, engine, index, local-spawn-backend, which)
- **drone-swarm-common**: 2 test files (tls, wiki-storage)
- **drone-core**: 2 test files (index, token-estimate)
- **drone-agent**: 49 test files + subagent tests

All 65 test files / 1,213 tests pass.

---

## Issues Found

### 1. TypeScript Errors in Test Files ⚠️ (5 errors)

**Root cause**: `getTool` method added to `DronePluginEngine` interface but test mocks not updated.

**Files affected**:
- `drone-agent/test/systemprompt.test.tsx` — 2 errors (lines 22, 117)
- `drone-agent/test/tui-persona-color.test.tsx` — 1 error (line 63)
- `drone-agent/test/tui.test.tsx` — 2 errors (lines 35, 192)

**Fix**: Add `getTool: () => undefined` (or a noop) to each mock engine object.

### 2. Unused Code (~70 hints)

Persistent issue, same scope as before. Examples:

**Source**:
- `drone-agent/src/plugins/file.ts` — `PatchHunk` type unused
- `drone-agent/src/plugins/lsp/server.ts` — `language` param unused (line 389)
- `drone-agent/src/plugins/macros/parser.ts` — `match` vars unused (lines 182, 202)
- `drone-agent/src/plugins/persona/wizard.ts` — `WizardContext` type unused
- `drone-agent/src/plugins/skills/wizard.ts` — `WizardContext` type unused
- `drone-agent/src/plugins/self-improvement/index.ts` — `DronePromptFragment`, `InsightFile`, `PrinciplesFile`, `principlesDir` all unused
- `drone-agent/src/plugins/swarm/index.ts` — `pushedEventCount` unused
- `drone-agent/src/runtime/conversation-service.ts` — `stuckSignature` unused
- `drone-agent/src/runtime/migration-service.ts` — `dir` unused (line 696)
- `drone-agent/src/tui/app.tsx` — `_debounced` unused
- `drone-beacon/src/index.ts` — `BeaconIdentity` unused
- `drone-beacon/src/routes/*.ts` — multiple `reply`/`request` params unused
- `drone-coordinator/src/index.ts` — `request` unused (line 381)
- `drone-gateway/src/engine.ts` — `coordinatorClient` unused

**Test files**:
- ~20+ test files import unused symbols (`beforeEach`, `afterEach`, `afterAll`, `createTestPlugin`, etc.)

**Fix**: Remove unused declarations. The test file hints are the most noise — clean them up piecemeal.

### 3. Large Files (Growing)

| File                                                | Lines  | Notes                        |
| --------------------------------------------------- | ------ | ---------------------------- |
| `drone-coordinator/test/routes.test.ts`             | 2,096  | Integration test, large      |
| `drone-coordinator/src/db.ts`                       | 1,707  | Database layer, large        |
| `drone-agent/test/self-improvement.test.ts`         | 1,607  | Large test file              |
| `drone-agent/src/plugins/swarm/index.ts`            | 1,386  | Swarm plugin, growing        |
| `drone-beacon/src/db.ts`                            | 1,294  | Database layer, large        |
| `drone-agent/src/plugins/lsp/tools.ts`              | 1,230  | LSP tools (unchanged)        |
| `drone-agent/src/plugins/lsp/normalize.ts`          | 1,153  | LSP normalize (unchanged)    |
| `drone-agent/src/runtime/migration-service.ts`      | 1,145  | NEW — migration service      |
| `drone-agent/src/plugins/self-improvement/index.ts` | 1,115  | Self-improvement (growing)   |
| `drone-agent/src/plugins/lsp/server.ts`             | 1,108  | LSP server (unchanged)       |

**Old** `drone-core/src/index.ts` (1,269 lines) is now **fixed** ✅

### 4. Type Duplication — Still Present

Types duplicated across:
- `drone-beacon/src/types.ts`
- `drone-coordinator/src/types.ts`
- `drone-core/src/domain-types.ts`

The `drone-core` has a `domain-types.ts` (48 lines) with `Persona`, `Skill`, `CreatePersonaRequest`, `CreateSkillRequest` — but beacon and coordinator still maintain their own copies.

### 5. New Packages Need Test Coverage

- **drone-coordinator-ui**: 22 files, 1,921 lines — **zero tests** (UI-only, somewhat expected)
- **docker/**: 5 files, 956 lines — **zero tests**

### 6. `migration-service.ts` — New Large File (1,145 lines)

This is a new file in `drone-agent/src/runtime/`. Unclear if it's a refactoring extraction from somewhere else or entirely new logic. Worth reviewing for further splitting opportunities.

---

## What's Working Well

- **drone-core modularization** — Successfully split the monolithic index.ts into 14 focused modules
- **Test coverage expansion** — beacon, coordinator, and gateway now have meaningful test suites
- **TUI architecture improvements** — Tail region refactor with live pre-rendering and plugin-customizable tool renders
- **Event streaming unification** — Single entry point for conversation events
- **All 1,213 tests pass** — No regressions despite significant new code
- **TypeScript compilation** — Source code compiles cleanly (only test mocks have errors)
- **New packages** — gateway and swarm-common are well-structured additions

---

## Refactoring Priority

| Priority | Issue                                         | Effort  | Notes                             |
| -------- | --------------------------------------------- | ------- | --------------------------------- |
| 1        | Fix 5 TS errors in test mocks (missing getTool) | Low     | Easy win, unblocks CI             |
| 2        | Remove unused code (~70 hints)                | Low     | Cleanup, reduces noise            |
| 3        | Split large files (swarm/index.ts, db.ts in beacon/coordinator) | Medium | Growing files                     |
| 4        | Consolidate duplicated types into drone-core  | High    | domain-types, beacon types, coordinator types |
| 5        | Add tests for drone-coordinator-ui            | Medium  | UI coverage                       |
| 6        | Review migration-service.ts for splitting     | Medium  | 1,145-line new file               |