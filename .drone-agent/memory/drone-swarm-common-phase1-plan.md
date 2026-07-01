---
key: drone-swarm-common-phase1-plan
tags:
  []
created: 2026-07-01T01:13:12.830Z
updated: 2026-07-01T01:46:34.180Z
---

# 🚀 Phase 1 Plan: Extract `drone-swarm-common` Package (Wiki-Storage + TLS)

## Summary

Extract the duplicated `wiki-storage.ts` (~98% identical, 377 lines each) and `tls.ts` (~95% identical, 124/128 lines) from `drone-beacon` and `drone-coordinator` into a new shared `drone-swarm-common` package. This eliminates ~500 lines of duplicated code and provides a single point of maintenance.

## Validation Criteria

- [x] `pnpm build` succeeds for all packages
- [x] `pnpm typecheck` passes with zero errors (pre-existing errors in llm-provider-switching.test.ts only)
- [x] `pnpm test` passes (all existing tests + new shared tests)
- [x] `pnpm lint` passes
- [x] All wiki-storage tests from both beacon and coordinator pass against the shared code
- [x] All TLS tests from both beacon and coordinator pass against the shared code
- [x] No remaining imports of `../wiki-storage.js` or `../tls.js` in beacon or coordinator source
- [x] The unused `randomUUID` import is gone from the shared wiki-storage

## Work Completed

All 10 steps of the plan were completed successfully:

1. **Created `drone-swarm-common` package skeleton** - package.json, tsconfig.json, src/index.ts
2. **Registered package in workspace** - pnpm-workspace.yaml, pnpm install
3. **Extracted `wiki-storage.ts`** - copied beacon version (no randomUUID import), removed unused logger import
4. **Extracted `tls.ts`** - added `setTlsLogger`, parameterized `loadOrCreateTlsIdentity` with `serviceName`
5. **Updated `drone-beacon`** - added dep, deleted old files, updated imports in index.ts, routes/wiki.ts, coordinator-client.ts
6. **Updated `drone-coordinator`** - added dep, deleted old files, updated imports in index.ts, routes/wiki.ts, passed 'coordinator' serviceName
7. **Created shared tests** - consolidated wiki-storage.test.ts (17 tests) and tls.test.ts (7 tests)
8. **Updated root vitest.config.ts** - added test include and resolve aliases
9. **Build and verify** - pnpm build, pnpm typecheck, pnpm test all pass
10. **Final verification** - all validation criteria satisfied

**Note:** The coordinator-client.test.ts in drone-beacon had to use a relative import path (`../../drone-swarm-common/src/tls.js`) instead of the package name because vitest's alias resolution for sub-path imports (`drone-swarm-common/tls`) doesn't work in that test context. The vitest config aliases for `drone-swarm-common/tls` and `drone-swarm-common/wiki-storage` are defined but only work for tests that import via the root alias (`drone-swarm-common`).