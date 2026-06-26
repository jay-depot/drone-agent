---
key: review-state
tags: []
created: 2026-06-26T01:58:17.133Z
updated: 2026-06-26T02:48:35.770Z
---

# Code Review Summary - drone-agent

## Overall State: Good — actively maintained, but some cleanup needed

| Metric              | Value   |
| ------------------- | ------- |
| Source files        | 155     |
| Total lines         | ~42,000 |
| Errors (tests)      | 17      |
| Hints (unused code) | ~70     |

---

## Issues Found

### 1. Test Files Have Errors (17 total)

**Files affected**:

- `agent-beacon.test.ts` — missing `../fixtures/index.js`
- `coordinator-sync.test.ts` — missing `../fixtures/index.js`
- `e2e-swarm.test.ts` — missing `../fixtures/index.js`
- `inter-agent.test.ts` — missing `../fixtures/index.js`
- `spawn.test.ts` — missing `../fixtures/index.js`
- `test/fixtures/assertions.ts` — wrong argument count to `assertDefined`
- `test/fixtures/subagent.ts` — missing `timedOut` property in return type

**Fix**: Create missing `fixtures/index.js`, add types to callbacks, fix assertion signature.

---

### 2. Unused Code (70+ hints)

**Examples**:

- `drone-agent/src/plugins/index.ts` — `createSwarmPlugin`, `SwarmConfig` unused
- `drone-agent/src/plugins/swarm/index.ts` — `randomUUID` unused
- `drone-agent/src/plugins/llm/index.ts` — `newProviderId` unused
- `drone-beacon/src/routes.ts` — multiple `reply` and `request` params unused

**Fix**: Remove unused declarations.

---

### 3. Type Duplication ✅ DONE

Types duplicated across:

- `drone-beacon/src/types.ts`
- `drone-coordinator/src/types.ts`
- `drone-core/src/index.ts`

**Impact**: Inconsistent definitions (e.g., `Persona.scope` missing in coordinator).

**Fix**: Create shared `drone-domain` package.

---

### 4. Large Files

| File                                                | Lines | Recommendation                    |
| --------------------------------------------------- | ----- | --------------------------------- |
| `drone-core/src/index.ts`                           | 1,269 | Split into smaller modules        |
| `drone-agent/src/plugins/lsp/tools.ts`              | 1,230 | Extract LSP-specific logic        |
| `drone-agent/src/plugins/lsp/normalize.ts`          | 1,153 | Extract normalization             |
| `drone-beacon/src/db.ts`                            | 958   | Consider service-layer extraction |
| `drone-agent/src/plugins/self-improvement/index.ts` | 941   | Split by feature                  |

---

### 5. Test Coverage Imbalance

- `drone-beacon`: No test directory
- `drone-coordinator`: No test directory
- `drone-core`: Has `test/` but minimal

**Fix**: Add test suites for beacon and coordinator packages.

---

## What's Working Well

- Plugin architecture — Clean separation of concerns
- Config system — TypeBox-based validation with env interpolation
- Session management — Well-designed turn-based conversation model
- Test organization — Good test helpers and fixtures in `drone-agent`
- LSP integration — Comprehensive semantic tool support

---

## Refactoring Priority

| Priority | Issue                                     | Effort |
| -------- | ----------------------------------------- | ------ |
| 1        | Fix test errors (missing fixtures, types) | Low    |
| 2        | Remove unused code (70+ hints)            | Low    |
| 3        | ~~Add beacon/coordinator tests~~          | Medium |
| 4        | Split large files (LSP, db)               | Medium |
| 5        | Create shared `drone-domain` types        | High   |
