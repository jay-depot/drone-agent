---
key: plan-codeql-uncontrolled-data-path-expression
tags: []
created: 2026-08-14T18:55:21.410Z
updated: 2026-08-14T18:55:21.410Z
---

# Plan: CodeQL — "Uncontrolled data used in path expression"

## Summary

CodeQL flags 5 sinks where user/config-supplied data flows into filesystem path expressions:

- drone-swarm-common/src/wiki-storage.ts:153 (readFile in writePage)
- drone-swarm-common/src/wiki-storage.ts:185 (writeFile in writePage)
- drone-swarm-common/src/wiki-storage.ts:195 (readFile in readPage)
- drone-swarm-common/src/wiki-storage.ts:218 (rm in deletePage)
- drone-swarm-common/src/spawner.ts:134 (cwd in spawn)

All 4 wiki sinks funnel through the single `pagePath(pageId)` choke point. The spawner `workingDir` is a separate sink.

## Behavior decisions (locked with user)

- **Wiki page IDs:** `pagePath()` already sanitizes via `pageId.replace(/[^a-zA-Z0-9_-]/g, '_')`, which strips `.` and `..` (dots become underscores) — path traversal via dots is already impossible. The only addition is a LENGTH LIMIT.
- **Spawner workingDir:** apply ONLY a length limit (option a). Dots/`..` are legitimate in a directory path (e.g. `../shared`), so do NOT reject them. The length limit is the real guard.

## Length limit value

Base on OS hard limits. PATH_MAX on Linux is 4096 bytes; Windows MAX_PATH is 260 (but modern Windows supports long paths up to 32767). Use a generous cap of 4096 characters for both, matching Linux PATH_MAX. This is far beyond any real wiki page ID or working dir, purely a safety bound.

## Steps

### 1. drone-swarm-common/src/wiki-storage.ts — length guard in pagePath()

`pagePath(pageId)` is the single choke point for all 4 wiki sinks. Add a length check at the top:

```ts
const MAX_PAGE_ID_LENGTH = 4096;

function pagePath(pageId: string): string {
  if (pageId.length > MAX_PAGE_ID_LENGTH) {
    throw new Error(`Wiki page ID exceeds maximum length: ${pageId.length}`);
  }
  const safe = pageId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getKbDir(), `${safe}.md`);
}
```

This guards all 4 sinks (153, 185, 195, 218) at once. Note: `readPage` and `deletePage` wrap `pagePath` calls in try/catch, so an over-length ID there returns null/false gracefully; `writePage` will throw (acceptable — reject the write).

### 2. drone-swarm-common/src/spawner.ts — length guard on workingDir

At the top of `spawnAgent`, before building args, validate the workingDir:

```ts
const MAX_WORKING_DIR_LENGTH = 4096;

// inside spawnAgent, before spawn():
const workingDir =
  (configOverride as { workingDir?: string })?.workingDir || process.cwd();
if (workingDir.length > MAX_WORKING_DIR_LENGTH) {
  throw new Error(
    `Working directory exceeds maximum length: ${workingDir.length}`
  );
}
```

Then use `workingDir` in both the `--working-dir` arg push and the `cwd:` option (currently duplicated inline). This also removes the duplicated `(configOverride as { workingDir?: string })?.workingDir` casts.

### 3. Tests

- drone-swarm-common/test/wiki-storage.test.ts:
  - `writePage` with an over-length page ID (> 4096) rejects with the length error.
  - `readPage` with an over-length page ID returns null (graceful, try/catch).
  - `deletePage` with an over-length page ID returns false (graceful, try/catch).
  - Existing "should prevent path traversal in page IDs" test still passes (dots already sanitized).
- drone-swarm-common/test/spawner.test.ts (NEW — no spawner test exists today):
  - `spawnAgent` with an over-length workingDir rejects with the length error.
  - `spawnAgent` with a normal workingDir succeeds (boundary / happy path).

### 4. Validation

LSP zero errors; `pnpm -r run lint` zero errors; `pnpm -r run build` zero errors; fast test suite passes.

## Files touched

- drone-swarm-common/src/wiki-storage.ts
- drone-swarm-common/src/spawner.ts
- drone-swarm-common/test/wiki-storage.test.ts
- drone-swarm-common/test/spawner.test.ts (new)

## Notes

- drone-swarm-common is a dependency of drone-beacon and drone-coordinator, which resolve it from built dist/. After editing drone-swarm-common/src, run `pnpm --filter drone-swarm-common run build` BEFORE running dependent-package tests, or they'll use stale dist.
- No drone-core changes.
