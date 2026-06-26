---
key: review-state
tags:
  []
created: 2026-06-26T01:58:17.133Z
updated: 2026-06-26T03:03:08.328Z
---

# Code Review Summary - drone-agent

## Overall State: Good — actively maintained, but some cleanup needed

| Metric | Value |
|--------|-------|
| Source files | 155 |
| Total lines | ~42,000 |
| Errors (tests) | 0 |
| Hints (unused code) | ~70 |

---

## Issues Found

### 1. Test Files Have Errors ✅ FIXED

**Files affected** (FIXED):
- `agent-beacon.test.ts` — wrong import path `../fixtures/index.js` → `./fixtures/index.js`
- `coordinator-sync.test.ts` — wrong import path
- `e2e-swarm.test.ts` — wrong import path
- `inter-agent.test.ts` — wrong import path
- `spawn.test.ts` — wrong import path
- `test/fixtures/docker.ts` — missing `exec` import

**Note**: Some items listed were inaccurate:
- `fixtures/index.js` existed (at `test/fixtures/index.ts`)
- `assertDefined` signature was correct
- `SubagentResult` had `timedOut` property

These are integration tests that require Docker containers to run (hook timeouts expected).

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

| File | Lines | Recommendation |
|------|-------|----------------|
| `drone-core/src/index.ts` | 1,269 | Split into smaller modules |
| `drone-agent/src/plugins/lsp/tools.ts` | 1,230 | Extract LSP-specific logic |
| `drone-agent/src/plugins/lsp/normalize.ts` | 1,153 | Extract normalization |
| `drone-beacon/src/db.ts` | 958 | Consider service-layer extraction |
| `drone-agent/src/plugins/self-improvement/index.ts` | 941 | Split by feature |

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
- TypeScript compilation — No errors

---

## Refactoring Priority

| Priority | Issue | Effort |
|----------|-------|--------|
| 1 | ~~Fix test errors~~ | Low |
| 2 | Remove unused code (70+ hints) | Low |
| 3 | Add beacon/coordinator tests | Medium |
| 4 | Split large files (LSP, db) | Medium |
| 5 | Create shared `drone-domain` types | High |