---
key: git-plugin-overhaul
tags:
  []
created: 2026-07-08T18:17:39.489Z
updated: 2026-07-08T18:36:33.409Z
---

# Plan: git Plugin Overhaul

_Last updated: 2026-07-08 (COMPLETED)_

## Status: COMPLETE (commit 3610a81)

## Why

The `git` plugin had a confirmed classification bug: `runGit()` returned `stdout.trim()`, stripping the leading space column of `git status --porcelain`, turning ` M file` into `M file` and misclassifying **unstaged** changes as **staged**. The plugin was also sparse (4 tools) and emitted raw JSON blobs.

## What shipped

- Split single `git.ts` into `git/` folder: `index.ts`, `run-git.ts`, `parse-porcelain.ts`, `types.ts`, `tools/*` (11 tool files), `components/*` (11 TUI components).
- 11 tools: `status`, `diff`, `log`, `show`, `add`, `restore`, `commit`, `branch`, `stash`, `fetch`, `pull`. `push` excluded per user.
- Fixed the bug: `status` uses `statusPorcelain(cwd)` (raw, untrimmed) → `parsePorcelain()` reads `--porcelain=v1` columns correctly.
- `commit` no longer force-stages; honors explicit `paths`/`all`/`includeUntracked`.
- `restore` (staged:true unstage; discard:true+paths drop, guard against discard w/o paths).
- `branch`/`stash` are action-based single tools. `fetch`/`pull` optional-arg, no remote mgmt. `show({ref,path?,contentsOnly?})`.
- Every tool has a TUI render component (no raw JSON blobs shown): status summary, diff/show via GitDiffBlock, add/restore/stash FS-change-colored lists (green=added/cyan=modified/red-strikethrough=removed), fetch/pull success|fail, branch list, commit stats, log entries.
- Tests: `git-parse-porcelain.test.ts` (unit, 8) + `git-plugin.test.ts` (temp-repo integration, 9) = 17 git tests. Full suite: 1291 tests / 89 files pass. typecheck + lint clean.

## Gotchas discovered & fixed during execution

1. **`.jsx` vs `.js` import extension:** Initially the tool `.ts` files imported components as `../components/X.jsx`. `tsc` emits `.js` and does NOT rewrite `.jsx`→`.js`, so the runtime build failed to resolve `StatusBlock.jsx` (ERR_MODULE_NOT_FOUND). Fixed by importing `.js` (matching how `GitDiffBlock.tsx` is imported elsewhere). Lesson: always import a `.tsx` sibling as `.js` in this codebase.
2. **Stale in-memory dist:** The running agent process loaded an old `dist` (before the fix / during the `.jsx` breakage), which is why early `git__status` calls misreported files as staged — despite the source being correct. Confirmed the rebuilt dist is correct by loading it in a fresh Node process.

## Open follow-ups (out of scope)

- Eventually all plugins move into folders + off JSON-blob indicators (user's long-term goal).
- `push` tool could be added later behind an explicit opt-in flag.
- `GitDiffBlock` could be relocated into `git/components/` and the legacy `tui/components` copy de-duplicated.
