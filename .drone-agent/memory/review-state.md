---
key: review-state
tags:
  []
created: 2026-06-26T01:58:17.133Z
updated: 2026-07-06T22:31:39.739Z
---

# Code Review Summary - drone-agent

## Overall State: Clean — actively maintained, significant tech debt paid down

| Metric              | Previous (Jun 26) | Current (Jul 7)  | Delta    |
| ------------------- | ----------------- | ---------------- | -------- |
| Source files        | 155               | 294              | +139     |
| Total lines         | ~42,000           | 72,536           | +30,536  |
| Test files passing  | 65                | 65               | 0        |
| Tests passing       | 1,213             | 1,213            | 0        |
| TypeScript errors   | 0 (source)        | 0                | 0        |
| Hints (unused code) | ~70               | ~5               | -65      |
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
2. **TUI tail region refactor** — Live pre-rendering with atomic commit
3. **Conversation event streaming unified** — Single entry point through engine hooks
4. **Plugin-customizable tool render components** — TUI tail region supports custom renderers

### Cleanup Completed (Jul 7)

1. **Fixed 5 TS errors** in test mocks (missing `getTool` on mock engine objects) ✅
2. **Removed ~80 unused declarations** across 47 files ✅
   - Source code: 14 files (unused types, variables, params, imports)
   - Test files: 20+ files (unused imports, variables, callback params)
   - Beacon/coordinator/gateway/swarm-common: 13 files
   - Net: 97 lines removed, 53 lines added (mostly `_` prefixes)

---

## Issues Found

### 1. TypeScript Errors — ✅ FIXED (Jul 7)

5 errors in test mocks (missing `getTool`). All resolved.

### 2. Unused Code — ✅ FIXED (Jul 7)

~70+ hints reduced to ~5. Remaining hints are low-value:
- `compaction/index.ts` (line 24) — "may be converted to async function" (suggestion, not a declaration)
- `drone-coordinator-ui/src/pages/login.tsx` — `FormEvent` is deprecated
- `drone-coordinator-ui/src/components/ui/scroll-area.tsx` — `React` import (might be needed for JSX)

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
| `drone-agent/src/runtime/migration-service.ts`      | 1,145  | Migration service            |
| `drone-agent/src/plugins/self-improvement/index.ts` | 1,113  | Self-improvement (growing)   |
| `drone-agent/src/plugins/lsp/server.ts`             | 1,108  | LSP server (unchanged)       |

**Old** `drone-core/src/index.ts` (1,269 lines) is now **fixed** ✅

### 4. Type Duplication — Still Present

Types duplicated across:
- `drone-beacon/src/types.ts`
- `drone-coordinator/src/types.ts`
- `drone-core/src/domain-types.ts`

### 5. New Packages Need Test Coverage

- **drone-coordinator-ui**: 22 files, 1,921 lines — **zero tests**
- **docker/**: 5 files, 956 lines — **zero tests**

---

## What's Working Well

- **drone-core modularization** ✅
- **Test coverage expansion** — beacon, coordinator, and gateway have test suites
- **TUI architecture improvements** — Tail region refactor with plugin-customizable tool renders
- **Event streaming unification** — Single entry point for conversation events
- **All 1,213 tests pass** — No regressions
- **TypeScript compilation** — Source code AND test code compile cleanly ✅
- **Codebase cleaned up** — ~80 unused declarations removed, ~70 hints eliminated

---

## Refactoring Priority

| Priority | Issue                                         | Effort  | Notes                             |
| -------- | --------------------------------------------- | ------- | --------------------------------- |
| 1        | ~~Fix 5 TS errors in test mocks~~             | Done    | Resolved Jul 7                    |
| 2        | ~~Remove unused code (~70 hints)~~            | Done    | Resolved Jul 7, ~5 hints remain   |
| 3        | Split large files (swarm/index.ts, db.ts)     | Medium  | Growing files                     |
| 4        | Consolidate duplicated types into drone-core  | High    | domain-types, beacon types, coordinator types |
| 5        | Add tests for drone-coordinator-ui            | Medium  | UI coverage                       |
| 6        | Review migration-service.ts for splitting     | Medium  | 1,145-line file                   |