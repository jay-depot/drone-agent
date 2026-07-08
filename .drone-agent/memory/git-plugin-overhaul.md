---
key: git-plugin-overhaul
tags: []
created: 2026-07-08T18:17:39.489Z
updated: 2026-07-08T18:17:39.489Z
---

# Plan: git Plugin Overhaul

_Last updated: 2026-07-08_

## Why

The `git` plugin (currently `drone-agent/src/plugins/git.ts`, 4 tools: `status`, `diff`, `commit`, `log`) has a confirmed classification bug: `runGit()` returns `stdout.trim()`, which strips the leading space column of `git status --porcelain`, turning ` M file` into `M file` and misclassifying **unstaged** changes as **staged**. Reproduced live (raw ` M AGENTS.md` reported as staged `M AGENTS.md`). The plugin is also sparse and emits raw JSON blobs for every tool. This overhaul fixes the bug, expands to a complete/sensible tool set, splits the single file into a `git/` folder, adds tests, and gives every tool a clean TUI render component (no JSON-blob output) — setting the precedent for the eventual all-plugins-in-folders + non-JSON tool indicators direction.

## Scope decisions (from grilling)

- **Tool set (11 tools):** `status`, `diff`, `log`, `show`, `add`, `restore`, `commit`, `branch`, `stash`, `fetch`, `pull`. **`push` is EXCLUDED** (user decision).
- **`status` fix:** parse `git status --porcelain=v1` from raw, untrimmed lines (split on `\n`, never trim the whole record). Correct staged(col 0)/unstaged(col 1) columns; handle renames (`a -> b`), unmerged (`UU`/`AA`), and untracked (`??`).
- **`commit` (no auto-stage):** does NOT run `git add -A`. Takes explicit `paths` (array) OR `all: true` (stages tracked+modified, `git add -u`) OR `includeUntracked: true` alongside `all` (full `git add -A`). `add` is the granular staging tool.
- **`restore` (`{ paths, staged?, discard? }`):** `staged: true` → unstage (`git restore --staged`). `discard: true` + `paths` → discard worktree (`git restore`). `discard: true` WITHOUT `paths` is rejected with an error (no accidental data loss). `discard: true` without `staged` and `paths` → error.
- **`branch({ action, name?, force? })`:** action ∈ `list`(default) | `create` | `switch` | `delete`. `delete` honors `force`.
- **`stash({ action, message?, index?, paths? })`:** action ∈ `list`(default) | `push` | `pop` | `apply` | `drop` | `clear`. `push` honors `message`/`paths`.
- **`fetch({ remote?, all?, prune? })` / `pull({ remote?, branch?, rebase? })`:** optional-arg, no remote management.
- **`show({ ref, path?, contentsOnly? })`:** `contentsOnly` defaults false → commit diff (vs HEAD). `contentsOnly: true` + `path` → file contents at ref (`git show <ref>:<path>`). `contentsOnly: true` without `path` → ignored (falls back to diff).
- **Structure:** split `git.ts` → `git/` folder (`index.ts` + per-tool files + `git/components/` for TUI components).
- **Tests:** porcelain-parser unit tests + integration tests (temp git repo round-trips) for write-path tools (`add`/`commit`/`branch`/`stash`/`restore`/`status`).

## TUI component decisions (firm layouts)

All 11 tools get a render component. `execute` still returns a JSON blob (consumed by the component via `ToolRenderState.result`); the goal is no raw JSON shown to the user.

- **status** → `## git status` + colored sections: staged (cyan), unstaged (yellow), untracked (red). Uses fixed `GitDiffBlock`-style coloring via `scheme`.
- **diff** → existing `GitDiffBlock` (imported from `tui/components/GitDiffBlock.tsx`).
- **show** → reuses `GitDiffBlock` (diff view) when `contentsOnly` false; contents view (plain) when true.
- **add** → `## git add` + bulleted list; new files green, existing modified cyan, removals red strikethrough. Color by actual FS change (`git status --porcelain` after add, or `git diff --cached --name-status`).
- **restore** → same styling as `add`; heading `## git restore` (or `## git restore --staged` when unstaging).
- **fetch** / **pull** → `## git <fetch|pull>: <success|fail>`; on fail append explanation line.
- **branch** → `## git branch <action> <branchName>` (+ list output for `list` action).
- **stash** → heading `## git stash <action>` + bulleted FS-change-colored list (like `add`).
- **commit** → `## git commit <shortHash>` (hash green) + message line + one-line stat (`N files changed, +M −K`). On fail → `## git commit: fail` + explanation.
- **log** → `## git log` (+ `<path>` suffix if filtered) + bulleted entries `hash — message` (hash cyan) with `author · date` dim.

## Files to create / modify

**New folder `drone-agent/src/plugins/git/`:**

- `index.ts` — `gitPlugin` metadata + `register()` that imports per-tool spec functions and registers each with `registration.registerTool(...)`. Re-exports `gitPlugin`.
- `run-git.ts` — shared `runGit(args, cwd?)` helper returning trimmed stdout for normal commands (NOT used for porcelain-status parsing, which gets raw lines via a dedicated `statusPorcelain(ts, cwd)` helper).
- `parse-porcelain.ts` — PURE function `parsePorcelain(raw: string): { branch, staged, unstaged, untracked }` used by `status` and tests. Handles `v1` XY codes, renames, untracked.
- `tools/status.ts`, `tools/diff.ts`, `tools/log.ts`, `tools/show.ts`, `tools/add.ts`, `tools/restore.ts`, `tools/commit.ts`, `tools/branch.ts`, `tools/stash.ts`, `tools/fetch.ts`, `tools/pull.ts` — each exports a function returning a `DroneToolDefinition` (name/description/inputSchema/execute/renderComponent).
- `components/StatusBlock.tsx`, `AddBlock.tsx`, `ShowBlock.tsx` (thin wrapper over `GitDiffBlock` + `tryParseJson`), `RestoreBlock.tsx` (shares AddBlock styling), `FetchPullBlock.tsx`, `BranchBlock.tsx`, `StashBlock.tsx`, `CommitBlock.tsx`, `LogBlock.tsx`.

**Modify:**

- `drone-agent/src/plugins/index.ts` — change `import { gitPlugin } from './git.js'` → `from './git/index.js'`.
- Delete old `drone-agent/src/plugins/git.ts` (replaced by folder).

**Tests (new):**

- `drone-agent/test/git-parse-porcelain.test.ts` — unit tests for `parsePorcelain`: staged `M `, unstaged ` M`, untracked `??`, renamed `R  a -> b`, unmerged `UU`, mixed.
- `drone-agent/test/git-plugin.test.ts` — integration: temp repo (`fs.mkdtemp` + `git init`), round-trips for `add`/`commit`(no auto-stage)/`branch`/`stash`/`restore`/`status`. Assert the misclassification regression is fixed (unstaged file reported in `unstaged`, not `staged`).

## Implementation steps (ordered, with dependencies)

1. **Create `git/parse-porcelain.ts`** — pure parser. No deps. Include `parsePorcelain(raw)` + types. (coder)
2. **Create `git/run-git.ts`** — `runGit` (trimmed stdout) + `statusLines(cwd)` returning raw untrimmed porcelain lines for the parser. (coder)
3. **Create `git/components/*` TUI components** — each parses `state.result` JSON via `tryParseJson` and renders with `scheme` colors. `ShowBlock`/`diff` reuse `GitDiffBlock`. (coder)
4. **Create `git/tools/*` files** — one per tool, each returning a `DroneToolDefinition` with `execute` returning the JSON struct the matching component consumes, plus `renderComponent`. (coder)
5. **Create `git/index.ts`** — assemble `gitPlugin`, register all tools. (coder)
6. **Update `plugins/index.ts`** import path `./git.js` → `./git/index.js`. (coder)
7. **Delete `git.ts`**. (coder)
8. **Write `git-parse-porcelain.test.ts`** (unit). (tester)
9. **Write `git-plugin.test.ts`** (integration, temp repo). (tester)
10. **`pnpm build`** to recompile (drone-core types unchanged, but dist must refresh). (coder)
11. **`pnpm typecheck`** — all packages. (reviewer)
12. **`pnpm test`** — run vitest; both new suites green. (tester)
13. **`pnpm lint`** — ESLint + Prettier clean. (reviewer)
14. **Validation pass** — confirm the original bug is gone: in a temp repo, modify a file (no `git add`), call `git__status`, assert it appears under `unstaged` not `staged`. (tester)

## Validation criteria

- All LSP checks / `pnpm typecheck` pass across packages.
- `pnpm lint` passes (ESLint + Prettier).
- `pnpm test` passes; new `git-parse-porcelain.test.ts` and `git-plugin.test.ts` are green.
- Regression check: `git__status` on an unstaged-but-not-staged file reports it under `unstaged`, never `staged`.
- All 11 tools present and registered; `push` is absent.
- Every tool has a non-JSON-blob TUI render component; `execute` returns the JSON struct the component consumes.
- No raw `stdout.trim()` applied to porcelain status output.
- `git` plugin still `defaultEnabled: false` in metadata.

## Open follow-ups (out of scope, noted for later)

- Eventually all plugins move into folders + off JSON-blob indicators (user's long-term goal).
- `push` tool could be added later behind an explicit opt-in flag if desired.
- `GitDiffBlock` could be relocated into `git/components/` and the legacy `tui/components` copy de-duplicated.
