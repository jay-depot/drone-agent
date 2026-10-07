---
tags: [decision, coordinator, beacon, refactor, testing]
related: [modules/drone-coordinator.md, modules/drone-beacon.md, decisions/041-beacon-coordinator-test-suite.md]
---

# ADR 042: Coordinator Server Refactor — buildApp(), Config Dirs, Wiki Root

**Status**: Implemented

**Date**: 2026-07-03

## Context

Three problems motivated this refactor:

1. **Untestable server assembly**: `drone-coordinator/src/index.ts` ran `main()` at import time and kept server assembly private, making it impossible to test route handlers via `fastify.inject()`. Extracting `buildApp()` was a prerequisite for the route test suite (ADR 041).

2. **Wiki collision**: A coordinator host must run a co-located beacon. Neither service called `setKnowledgeBaseDir()`, so both defaulted to `wiki-storage`'s hardcoded `./knowledge-base` (relative to cwd). Run from the same directory, they'd write their wikis over each other.

3. **Sensible defaults**: `./config` (cwd-relative) is a poor default for long-running services. `~/.drone-coordinator` and `~/.drone-beacon` mirror the `~/.drone-agent` convention.

## Decision

### 1. Extract `buildApp()`

Created a side-effect-free `buildApp()` function in `drone-coordinator/src/index.ts` that:

- Creates a Fastify instance (with optional TLS)
- Registers CORS
- Optionally attaches auth middleware via `createWebAuthMiddleware(getToken)`
- Registers all API routes via `registerRoutes(app)`

The function is exported and testable. It does NOT include WebSocket, static file serving, or the SPA fallback — those remain as `attachUi()` called from `main()`.

### 2. Separate `main()` from import

Added an entry guard so `index.ts` doesn't self-invoke at import time:

```typescript
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main();
}
```

The `bin/drone-coordinator` wrapper was updated to call `main()` explicitly.

### 3. Change default config directories

- Coordinator: `./config` → `~/.drone-coordinator`
- Beacon: `./config` → `~/.drone-beacon`

### 4. Anchor wiki under config dir

Both services now call `setKnowledgeBaseDir(path.join(config.configDir, 'knowledge-base'))` during startup, ensuring each service has its own wiki directory.

## Consequences

**Positive**:

- `buildApp()` is directly testable via `fastify.inject()`, enabling the route test suite (ADR 041)
- Wiki collision is resolved — coordinator and beacon each write to their own `knowledge-base/` under their config dir
- Default config dirs follow the `~/.drone-agent` convention
- No backward-compatibility shim needed (single-user project; user already overrides these paths)

**Negative**:

- `buildApp()` can't be used directly in tests because `index.ts` has top-level imports of `drone-swarm-common/tls` which don't resolve in the test environment. Route tests use a separate `app-helper.ts` instead.

## Related

- [041-beacon-coordinator-test-suite](041-beacon-coordinator-test-suite.md) — Route test suite that depends on this refactor
- [drone-coordinator](../../drone-coordinator/) — Coordinator module with updated config defaults
- [drone-beacon](../../drone-beacon/) — Beacon module with updated config defaults
