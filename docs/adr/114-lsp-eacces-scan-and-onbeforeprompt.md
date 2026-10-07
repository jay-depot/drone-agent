---
tags: [decision, lsp, plugin-system, error-handling, robustness]
related: [modules/drone-agent-plugins.md, architecture/plugin-system.md, flows/plugin-lifecycle.md, modules/drone-agent.md, decisions/069-lsp-ergonomics.md, decisions/098-lsp-file-list-mount-conversion.md, decisions/102-multi-language-lsp-support.md]
---

# ADR 114: LSP Workspace Scan EACCES Hardening + Non-Fatal `onBeforePrompt` Hooks

**Status**: Implemented (commit `9943b8a`, 2026-08-11, branch `fix/lsp-eacces-scan`)

## Context

Running the agent from the home directory (`~`, typical for sysadmin tasks) surfaced a hard crash:

```
Error: EACCES: permission denied, scandir '/home/unleet/.dropbox-dist'
```

This aborted the conversation loop. The failure chain:

1. The LSP plugin's `server.initialize()` spawns servers and marks the workspace dirty.
2. On the first prompt, `refreshIfNeeded()` → `syncServerDocuments()` → **`collectWorkspaceFiles()`** walks the workspace root recursively.
3. `collectWorkspaceFiles` (`drone-agent/src/plugins/lsp/server/helpers.ts`) did an **unguarded** per-directory `readdir`. Descending into an unreadable subdirectory (`.dropbox-dist` is created by Dropbox with permissions the user can't scan) threw `EACCES`.
4. The throw propagated up through `syncServerDocuments` → `refreshIfNeeded` → the **`onBeforePrompt`** hook → `engine.runHooks('onBeforePrompt')` → the driver.
5. The crash occurred **before** `sendUserMessage` was ever called:
   - In **TUI mode** (`tui/app.tsx:469`) the hook error is caught and logged, but the turn is aborted — the user's message is silently eaten.
   - In **plain / `--chat` / `--once` / interactive** modes (`interactive.ts:111`, `index.tsx:296`), `runHooks('onBeforePrompt')` is unguarded, so the error threw straight out of the loop and terminated the session.

Notably, the sibling function `hasMatchingFiles` (used for server *detection*) already guarded every `opendir` with `.catch(() => null)` — two identical recursive walkers had inconsistent hardening.

## Decision

Two-part hardening, each addressing a distinct layer:

### 1. Guard `collectWorkspaceFiles`' per-directory `readdir`

Wrap the recursive walker's `readdir` in `.catch(() => [])` so an unreadable directory is **skipped** rather than throwing, matching the existing `hasMatchingFiles` behavior:

```ts
const entries = await readdir(directoryPath, { withFileTypes: true }).catch(
  () => []
);
```

This fixes the root cause for the home-directory scenario. Excluding specific directories (e.g. adding `.dropbox-dist` to `EXCLUDED_DIRECTORIES`) was explicitly rejected as a band-aid — any other unreadable directory would reproduce the crash.

### 2. Make `onBeforePrompt` hooks non-fatal in `engine.runHooks`

In `drone-agent/src/runtime/plugin-engine.ts`, `runHooks` now catches a failing `onBeforePrompt` callback, logs `onBeforePrompt hook error (non-fatal)`, and **continues** to the next hook instead of rethrowing. This mirrors the existing non-fatal `onAfterToolCall` handling in the conversation service (`conversation-service.ts:569`, which wraps it in try/catch as `hook error (non-fatal)`).

```ts
runHooks: async hookName => {
  for (const callback of hookBuckets[hookName]) {
    try {
      await callback();
    } catch (hookError) {
      if (hookName === 'onBeforePrompt') {
        const msg = hookError instanceof Error ? hookError.message : String(hookError);
        logger.warn(`onBeforePrompt hook error (non-fatal): ${msg}`);
        continue;
      }
      throw hookError;
    }
  }
},
```

All other hooks still rethrow. This is a **single-point defense** at the shared chokepoint every driver (TUI, `--chat`, `--once`, interactive, workflow kickback) goes through, so a plugin failure can never silently swallow a user message or terminate the session.

## Design decisions

- **Skip, don't exclude.** Guarding the `readdir` is the robust fix; maintaining a blocklist of unreadable directories is whack-a-mole.
- **Engine-level containment, not per-driver.** The `onBeforePrompt` guard lives in `runHooks` so every caller benefits, rather than adding try/catch at each of the ~10 call sites. Other hooks (which may legitimately need to abort) are untouched.
- **Only `onBeforePrompt` is softened.** `onAfterToolCall` was already non-fatal in the conversation service; `onPluginsLoaded`/`onSessionStart`/`onShutdown` errors should still propagate since they run at startup/teardown, not mid-turn.

## Consequences

### Positive

- Running from a home directory (or any workspace with unreadable subdirectories) no longer crashes the loop or eats messages.
- Consistent hardening between the two workspace walkers (`collectWorkspaceFiles` and `hasMatchingFiles`).
- A plugin failure in `onBeforePrompt` (LSP refresh, compaction evaluation, swarm correlation-ID, etc.) is now logged and non-fatal, matching the established `onAfterToolCall` pattern.

### Neutral

- The `onBeforePrompt` non-fatal behavior applies to **all** plugins' `onBeforePrompt` hooks, not just LSP. Verified no plugin uses `onBeforePrompt` throwing to intentionally abort a turn (LSP refresh, compaction already self-contained, swarm correlation-ID).

## Tests

- `drone-agent/test/lsp-helpers.test.ts` (new, 2 tests): mocks `readdir` to throw EACCES on a subdirectory (the `.dropbox-dist` scenario) and asserts `collectWorkspaceFiles` skips it and still returns the readable matches; plus a control test for the all-readable path. **Verified the EACCES test fails without the fix** (reproduces the reported `permission denied` crash) and passes with it.

**Validation**: LSP clean on all touched files; `pnpm -r run build` passes; prettier clean (eslint ignores `drone-agent/src/**` and test files); full suite 1789 passed / 9 skipped.

## Related

- [[modules/drone-agent-plugins]] — The LSP plugin row
- [[architecture/plugin-system]] — Hook ordering and lifecycle semantics
- [[flows/plugin-lifecycle]] — The `onBeforePrompt` / `onAfterToolCall` hook flow
- [[decisions/069-lsp-ergonomics]] — Earlier LSP ergonomics work
- [[decisions/098-lsp-file-list-mount-conversion]] / [[decisions/102-multi-language-lsp-support]] — LSP plugin architecture context
