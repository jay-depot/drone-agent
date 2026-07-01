---
key: tool-name-separator-change
tags:
  - plan
  - tool-names
  - kimi-compatibility
created: 2026-07-01T02:03:36.606Z
updated: 2026-07-01T02:03:36.606Z
---

# Plan: Change Tool Name Separator from `.` to `__`

## Why

Kimi 2.7 Code (and the entire Kimi K2 family) has a documented sensitivity to dots in tool names. The model was trained on tool names using only `[a-zA-Z0-9_-]`, and its internal tool-call ID format (`functions.{name}:{idx}`) uses the dot as a structural separator — so a tool named `exec.run` gets parsed incorrectly, causing the model to hallucinate `"run"` as a tool name. This change replaces the canonical tool name separator from `.` to `__` (double underscore) to fix compatibility.

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `drone-core/src/utils.ts:83` | Change `getCanonicalToolName` to return `` `${pluginId}__${toolName}` `` |
| 2 | `drone-core/test/index.test.ts` | Update all hardcoded dot-separated names to `__` |
| 3 | `drone-agent/src/plugins/file.ts` | Update hardcoded `'file.read'`, `'file.list'`, `'file.write'`, `'file.apply_diff'`, `'file.glob'` in error messages |
| 4 | `drone-agent/src/plugins/exec.ts` | Update hardcoded `'exec.run'` in error messages |
| 5 | `drone-agent/src/plugins/git.ts` | Update hardcoded `'git.commit'` in error message |
| 6 | `drone-agent/src/plugins/todo.ts` | Update hardcoded `'todo.manage_list'` in error messages AND in `engine.executeTool()` calls |
| 7 | `drone-agent/src/plugins/search.ts` | Update hardcoded `'search.text'` in error message |
| 8 | `drone-agent/src/plugins/skills/index.ts` | Update hardcoded `'skills.recall'`, `'skills.list'`, `'skills.reload'` in `engine.executeTool()` calls |
| 9 | `drone-agent/src/plugins/config/index.ts` | Update hardcoded `'config.get'`, `'config.set'` in error messages |
| 10 | `drone-agent/src/plugins/mcp/index.ts` | Update MCP tool mounting to use `__` separator |
| 11 | `drone-agent/test/bootstrap.test.ts` | Update `'git.status'` references |
| 12 | `drone-agent/test/cli-workflow.test.ts` | Update `'file.list'` references |
| 13 | `drone-agent/test/config-plugin.test.ts` | Update `'config.list_layers'` references |
| 14 | `drone-agent/test/file.test.ts` | Update hardcoded `'file.read'`, `'file.list'`, `'file.write'`, `'file.glob'` in test assertions |
| 15 | `drone-agent/test/persona-loader.test.ts` | Update `allowedTools` patterns from `'exec.*'` to `'exec*'` |
| 16 | `drone-agent/README.md` | Update documented tool names |
| 17 | `drone-agent/AGENTS.md` | Update any tool name references |

## Step-by-Step Implementation

**Step 1 — Change the separator function** in `drone-core/src/utils.ts`

**Step 2 — Update `drone-core/test/index.test.ts`** — all `getCanonicalToolName`, `matchGlob`, `filterByGlobPatterns` tests

**Step 3 — Update hardcoded error message strings** in `file.ts`, `exec.ts`, `git.ts`, `todo.ts`, `search.ts`

**Step 4 — Update hardcoded canonical names used for dispatch** in `todo.ts`, `skills/index.ts`

**Step 5 — Update MCP tool mounting** in `mcp/index.ts`

**Step 6 — Update test files** — `bootstrap.test.ts`, `cli-workflow.test.ts`, `config-plugin.test.ts`, `file.test.ts`, `persona-loader.test.ts`

**Step 7 — Update documentation** — `README.md`, `AGENTS.md`

**Step 8 — Build and verify** — `pnpm build && pnpm typecheck && pnpm test && pnpm lint`

## Validation Criteria

1. `pnpm build` compiles all packages without errors
2. `pnpm typecheck` passes with zero type errors
3. `pnpm test` passes all tests
4. `pnpm lint` passes (ESLint + Prettier)
5. LSP diagnostics show zero errors across the workspace
6. All hardcoded `'plugin.tool'` strings in source code have been updated to `'plugin__tool'`
7. No remaining references to the old dot-separated canonical name format in source or test files (excluding `node_modules` and `dist/`)

## Dependencies

All steps are sequential — each depends on the previous. The order is: core function → tests → plugin error messages → plugin dispatch calls → MCP mounting → test files → docs → build verification.