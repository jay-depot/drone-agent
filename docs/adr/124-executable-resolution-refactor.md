---
tags: [decision, executable-resolution, refactor]
related: [modules/drone-core.md, modules/drone-gateway.md, modules/drone-beacon.md, concepts/subagent.md, decisions/115-subagent-mode-and-return-tool.md]
---

# 124. Executable Resolution Refactor

**Summary**: Consolidated executable resolution across the monorepo into a single shared helper in `drone-core`, replacing ad-hoc `which`/PATH logic in `drone-gateway` and manual checks elsewhere.

## Context

Previously each package that spawned a `drone-agent` process invented its own resolution strategy:

- `drone-gateway` had a custom `which` implementation plus a hard-coded "starts with `/`" absolute-path check.
- `drone-beacon` relied on the caller to supply a valid path.
- `drone-agent` subagent logic had its own PATH-first + `argv[1]` fallback behavior.

This caused a bug where subagent dispatch searched the CWD for the agent binary rather than the user's `$PATH`.

## Decision

Add two shared helpers to `drone-core/src/utils.ts`:

### `commandExistsOnPath(command, env)`

Returns `true` when `command` resolves to an executable file on PATH. Respects absolute/relative paths and (on Windows) `PATHEXT`. Avoids shelling out so the result is deterministic in tests.

### `resolveDroneExecutable(options)`

```typescript
export interface ResolveDroneExecutableOptions {
  commandName?: string;
  env?: NodeJS.ProcessEnv;
  fallbackArgv1?: string;
}
```

Resolution order:
1. Accepts an absolute or relative path and validates executability.
2. Falls back to PATH lookup (with Windows `PATHEXT` support).
3. Optionally falls back to `argv[1]` when the configured name is not found.
4. Throws a clear, consistent error message on failure.

## Changes

- Added `commandExistsOnPath(command, env)` and `resolveDroneExecutable(options)` to `drone-core/src/utils.ts`.
- Exported both helpers from `drone-core/src/index.ts`.
- Added unit tests for both helpers in `drone-core/test/index.test.ts`.
- `drone-agent` subagent plugin now resolves `drone-agent` via `resolveDroneExecutable({ fallbackArgv1: process.argv[1] })`.
- `drone-agent` subagent test fixture uses the same helper to find the binary under test.
- `drone-beacon` startup resolves `config.spawnAgentPath` with `resolveDroneExecutable({ commandName: config.spawnAgentPath })` before passing the resolved path to the spawner.
- `drone-gateway` `LocalSpawnBackend` replaced its local `which.js`-based `resolveAgentPath` with `resolveDroneExecutable({ commandName: this.agentPath })`.
- `drone-gateway/test/local-spawn-backend.test.ts` was updated to mock `drone-core` instead of the removed local `which.js` path, and now asserts that the default `commandName: 'drone-agent'` is used when no `agentPath` is configured.
- `drone-agent/src/plugins/lightpanda/index.ts` and `drone-agent/src/plugins/lsp/installer.ts` now import `commandExistsOnPath` from `drone-core` instead of defining their own local copies.
- `docker/drone-beacon.Dockerfile` adds `/app/drone-agent/bin` to `PATH` so the beacon can find the agent binary.
- Added `docs/agents/executable-resolution-refactor.md` documenting the refactor.

## Consequences

- Reduces duplication and makes spawn failures easier to diagnose across the swarm.
- The shared helper unifies the resolution behaviors across all packages.
- The subagent bug (searching CWD instead of PATH) is fixed.

## Related

- [[concepts/subagent]] — Subagent spawning
- [[modules/drone-core]] — Shared utilities
- [[modules/drone-gateway]] — LocalSpawnBackend
- [[modules/drone-beacon]] — Spawner configuration
