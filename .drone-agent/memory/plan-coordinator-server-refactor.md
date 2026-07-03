---
key: plan-coordinator-server-refactor
tags:
  - plan
  - coordinator
  - beacon
  - refactor
  - config
  - wiki
  - roadmap-3.10-prereq
  - completed
created: 2026-07-03T01:13:38.965Z
updated: 2026-07-03T01:28:31.630Z
---

# Plan A — Coordinator Server Refactor + Config-Dir + Wiki-Root

## Summary

**What:** Refactor `drone-coordinator/src/index.ts` so the API server is assembled by an exported, side-effect-free `buildApp()` function (separated from UI-serving glue and from `main()`), change the default config directories for both the coordinator and beacon to per-service home-dir paths, and anchor each service's wiki (\"knowledge-base\") directory under its own config dir.

**Why:**
1. **Testability (primary driver):** `index.ts` currently runs `main()` at import time and keeps `setupServer` private, so route handlers cannot be exercised via `fastify.inject()`. Extracting `buildApp()` unblocks Plan B (coordinator route test coverage, roadmap item 3.10) and makes the assembled API app — including auth middleware — directly testable.
2. **Wiki collision fix:** A coordinator host must run a co-located beacon. Neither service currently calls `setKnowledgeBaseDir()`, so both default to `wiki-storage`'s hardcoded `./knowledge-base` (relative to cwd). Run from the same directory, they write their wikis over each other. Anchoring the wiki under each service's config dir — combined with distinct default config dirs — resolves this.
3. **Sensible defaults:** `./config` (cwd-relative) is a poor default for long-running services. `~/.drone-coordinator` and `~/.drone-beacon` mirror the `~/.drone-agent` convention.

**No backward-compatibility shim is required** (single-user project; the user already overrides these paths).

**This plan is a prerequisite for Plan B (`plan-coordinator-route-tests`).**

---

## Status: COMPLETED (2026-07-03)

All steps completed successfully:

1. ✅ Coordinator default config dir changed to `~/.drone-coordinator`
2. ✅ Beacon default config dir changed to `~/.drone-beacon`
3. ✅ Extracted `buildApp()` in coordinator - creates Fastify instance with CORS, optional auth, and API routes
4. ✅ Rewired `main()` to use `buildApp()` + `attachUi()`
5. ✅ Added entry guard for self-invoke prevention
6. ✅ Updated `bin/drone-coordinator` to call `main()` explicitly
7. ✅ Anchored coordinator wiki under config dir (`<configDir>/knowledge-base`)
8. ✅ Anchored beacon wiki under config dir (`<configDir>/knowledge-base`)
9. ✅ Verified no existing tests depend on old defaults
10. ✅ Validation: typecheck (changed packages), lint, test (913/916 pass, 3 pre-existing failures), build (changed packages)

Commit: `e5f1fce` on branch `main`

## Design Decisions (settled with user)

- **`buildApp(opts?)` scope:** assembles CORS + optional auth `onRequest` hook + `registerRoutes(app)` only. WebSocket (`/ws`), `@fastify/static`, the `/` index route, and the SPA `setNotFoundHandler` fallback remain **UI-serving glue** attached inside `main()` (via `attachUi(app, uiDistPath)` helper).
- **Entry guard:** `index.ts` exports `main` (and `buildApp`) and does NOT self-invoke at import. The bin wrapper explicitly calls `main()`.
- **Wiki dir name:** `knowledge-base` (path: `<configDir>/knowledge-base`).
- **Config dirs:** coordinator `~/.drone-coordinator`, beacon `~/.drone-beacon`, via `os.homedir()`.