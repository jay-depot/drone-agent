# Executable Resolution Refactor

## Summary

Consolidated executable resolution across the monorepo into a single shared helper in `drone-core`, replacing ad-hoc `which`/PATH logic in `drone-gateway` and manual checks elsewhere.

## Changes

- Added `commandExistsOnPath(command, env)` and `resolveDroneExecutable(options)` to `drone-core/src/utils.ts`.
- Exported both helpers from `drone-core/src/index.ts`.
- Added unit tests for both helpers in `drone-core/test/index.test.ts`.
- `drone-agent` subagent plugin now resolves `drone-agent` via `resolveDroneExecutable({ fallbackArgv1: process.argv[1] })`.
- `drone-agent` subagent test fixture uses the same helper to find the binary under test.
- `drone-beacon` startup resolves `config.spawnAgentPath` with `resolveDroneExecutable({ commandName: config.spawnAgentPath })` before passing the resolved path to the spawner.
- `drone-gateway` `LocalSpawnBackend` replaced its local `which.js`-based `resolveAgentPath` with `resolveDroneExecutable({ commandName: this.agentPath })`.
- `drone-gateway/test/local-spawn-backend.test.ts` was updated to mock `drone-core` instead of the removed local `which.js` path, and now asserts that the default `commandName: 'drone-agent'` is used when no `agentPath` is configured.

## Rationale

Previously each package that spawned a `drone-agent` process invented its own resolution strategy:

- `drone-gateway` had a custom `which` implementation plus a hard-coded "starts with `/`" absolute-path check.
- `drone-beacon` relied on the caller to supply a valid path.
- `drone-agent` subagent logic had its own PATH-first + `argv[1]` fallback behavior.

The shared helper unifies these behaviors:

1. Accepts an absolute or relative path and validates executability.
2. Falls back to PATH lookup (with Windows `PATHEXT` support).
3. Optionally falls back to `argv[1]` when the configured name is not found.
4. Throws a clear, consistent error message on failure.

This reduces duplication and makes spawn failures easier to diagnose across the swarm.

## API

```ts
import { resolveDroneExecutable, commandExistsOnPath } from 'drone-core';

// Check only
const ok = await commandExistsOnPath('drone-agent');

// Resolve with optional argv[1] fallback
const path = await resolveDroneExecutable({
  commandName: 'drone-agent',
  fallbackArgv1: process.argv[1],
});
```

## Related Commits

- `130baa9` — refactor(gateway): use shared `resolveDroneExecutable` from `drone-core`
- Earlier commits added the helper to `drone-core` and wired it into `drone-agent` and `drone-beacon`.

## Status

Completed.
