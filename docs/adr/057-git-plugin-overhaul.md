---
tags: [decision, git, plugins, tui]
related: [047-plugin-customizable-tool-render.md, modules/drone-agent-plugins.md]
---

# ADR 057: Git Plugin Overhaul — Folder Split, 11 Tools, TUI Components

**Status**: Implemented (commit `3610a81`, 2026-07-08)

## Context

The `git` plugin was a single 225-line file (`drone-agent/src/plugins/git.ts`) with 4 tools: `status`, `diff`, `commit`, `log`. It had a confirmed classification bug: `runGit()` returned `stdout.trim()`, which stripped the leading space column of `git status --porcelain`, turning ` M file` into `M file` and misclassifying **unstaged** changes as **staged** (reproduced live). The plugin was also sparse and emitted raw JSON blobs for every tool, contrary to the project's direction of moving away from JSON-blob tool indicators.

## Decision

Overhaul the git plugin into a `git/` folder with 11 tools, each with a custom TUI render component. Key design decisions:

### Tool Set (11 tools, `push` excluded)

| Category | Tools |
|----------|-------|
| **Read-only** | `status`, `diff`, `log`, `show` |
| **Local write** | `add`, `restore`, `commit`, `branch`, `stash` |
| **Remote (no push)** | `fetch`, `pull` |

### Status Classification Fix

The root cause was `runGit()` calling `stdout.trim()` on the entire porcelain output. The fix introduces a dedicated `statusPorcelain(cwd)` helper that returns the **raw, untrimmed** stdout. A pure `parsePorcelain()` function reads the two-column XY format (`--porcelain=v1`) directly, preserving the leading space in column 0 (index/staged flag). The `runGit()` helper is retained for all other commands where trimming is safe.

### Commit Behavior Change

Previously `commit` force-ran `git add -A` (staging everything including untracked files). Now it does **not** auto-stage. It accepts:
- Explicit `paths` (array) — stage and commit only those files
- `all: true` — stage tracked+modified (`git add -u`)
- `all: true` + `includeUntracked: true` — full `git add -A`

A dedicated `add` tool provides granular staging.

### Restore Semantics

Uses the modern `git restore` idiom:
- `staged: true` → unstage (`git restore --staged`)
- `discard: true` + `paths` → discard worktree changes (irreversible, requires explicit opt-in)
- `discard: true` without `paths` → rejected with error (safety guard)

### Action-Based Tools

`branch` and `stash` are single tools with an `action` field (default `list`), keeping the tool namespace tidy:
- `branch({ action: 'list'|'create'|'switch'|'delete', name?, force? })`
- `stash({ action: 'list'|'push'|'pop'|'apply'|'drop'|'clear', message?, index?, paths? })`

### Show Semantics

`show({ ref, path?, contentsOnly? })`:
- Default (`contentsOnly: false`) → commit diff vs HEAD
- `contentsOnly: true` + `path` → file contents at ref (`git show <ref>:<path>`)
- `contentsOnly: true` without `path` → ignored (falls back to diff)

### TUI Components

Every tool has a custom render component (no raw JSON blobs shown):
- **status** → `## git status` + colored sections (staged=cyan, unstaged=yellow, untracked=red)
- **diff** / **show** → existing `GitDiffBlock` (diff view)
- **add** / **restore** / **stash** → `## git <cmd>` + bulleted list colored by actual FS change (green=added, cyan=modified, red-strikethrough=removed)
- **fetch** / **pull** → `## git <cmd>: <success|fail>` + explanation on fail
- **branch** → `## git branch <action> <name>` + list output
- **commit** → `## git commit <shortHash>` (green) + message + stat (`N files changed, +M −K`)
- **log** → `## git log [<path>]` + bulleted `hash — message` (cyan) + dim `author · date`

### Folder Structure

```
plugins/git/
├── index.ts              — Plugin metadata + register() wiring
├── run-git.ts            — runGit() + statusPorcelain() + helpers
├── parse-porcelain.ts    — Pure porcelain parser
├── types.ts              — Shared types + nameStatusToItems()
├── tools/                — One file per tool (DroneToolDefinition factory)
│   ├── status.ts, diff.ts, log.ts, show.ts
│   ├── add.ts, restore.ts, commit.ts
│   ├── branch.ts, stash.ts, fetch.ts, pull.ts
└── components/           — TUI render components
    ├── list.tsx          — Shared list renderer + heading helper
    ├── StatusBlock.tsx, AddBlock.tsx, RestoreBlock.tsx
    ├── CommitBlock.tsx, LogBlock.tsx, BranchBlock.tsx
    ├── StashBlock.tsx, ShowBlock.tsx, FetchPullBlock.tsx
```

### Test Coverage

- **`git-parse-porcelain.test.ts`** (unit, 8 tests) — staged, unstaged, untracked, renames, unmerged, mixed, clean tree
- **`git-plugin.test.ts`** (integration, 9 tests) — temp repo round-trips for `add`/`commit`/`branch`/`stash`/`restore`/`status`; regression test confirming unstaged files appear under `unstaged` not `staged`

## Consequences

### Positive

- Status classification bug is fixed: `git__status` correctly distinguishes staged vs unstaged by reading the porcelain index column from raw, untrimmed output
- 11 tools cover the full local git workflow; `push` can be added later behind an opt-in flag
- Every tool has a clean TUI component — no JSON blobs shown to the user
- Folder structure sets the precedent for the eventual all-plugins-in-folders migration
- 17 new tests (8 unit + 9 integration) prevent regression

### Negative

- Existing workflows that relied on `commit` auto-staging everything will need to pass `all: true` or explicit `paths`
- The `git` plugin remains `defaultEnabled: false` (must be enabled in config)

### Gotchas Discovered

1. **`.jsx` vs `.js` import extension**: Tool `.ts` files initially imported components as `../components/X.jsx`. `tsc` emits `.js` for `.tsx` sources and does NOT rewrite `.jsx`→`.js`, so the runtime build failed with `ERR_MODULE_NOT_FOUND`. Fixed by importing `.js` (matching the existing pattern for `GitDiffBlock.tsx`).
2. **Stale in-memory dist**: The running agent process loaded an old `dist` (before the fix / during the `.jsx` breakage), causing early `git__status` calls to misreport files as staged despite the source being correct. The rebuilt dist was confirmed correct by loading it in a fresh Node process.

## Related

- [047-plugin-customizable-tool-render](047-plugin-customizable-tool-render.md) — The `renderComponent` field that enabled custom TUI components per tool
- [drone-agent-plugins](../../drone-agent/src/plugins/) — Updated to reflect the new folder structure and tool set
