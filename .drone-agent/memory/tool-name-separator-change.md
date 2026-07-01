---
key: tool-name-separator-change
tags:
  - plan
  - tool-names
  - kimi-compatibility
  - completed
created: 2026-07-01T02:03:36.606Z
updated: 2026-07-01T02:14:41.394Z
---

# Plan: Change Tool Name Separator from `.` to `__`

## Why

Kimi 2.7 Code (and the entire Kimi K2 family) has a documented sensitivity to dots in tool names. The model was trained on tool names using only `[a-zA-Z0-9_-]`, and its internal tool-call ID format (`functions.{name}:{idx}`) uses the dot as a structural separator — so a tool named `exec.run` gets parsed incorrectly, causing the model to hallucinate `"run"` as a tool name. This change replaces the canonical tool name separator from `.` to `__` (double underscore) to fix compatibility.

## Files Modified

| # | File | Change |
|---|------|--------|
| 1 | `drone-core/src/utils.ts` | `getCanonicalToolName` returns `` `${pluginId}__${toolName}` `` |
| 2 | `drone-core/test/index.test.ts` | All test assertions updated to `__` format |
| 3 | `drone-agent/src/plugins/file.ts` | Error messages: `file__read`, `file__list`, etc. |
| 4 | `drone-agent/src/plugins/exec.ts` | Error messages: `exec__run` |
| 5 | `drone-agent/src/plugins/git.ts` | Error messages: `git__commit` |
| 6 | `drone-agent/src/plugins/todo.ts` | Error messages + dispatch: `todo__manage_list` |
| 7 | `drone-agent/src/plugins/search.ts` | Error messages: `search__text` |
| 8 | `drone-agent/src/plugins/skills/index.ts` | Dispatch: `skills__recall`, `skills__list`, etc. |
| 9 | `drone-agent/src/plugins/persona/index.ts` | Dispatch: `persona__list`, `persona__select`, etc. |
| 10 | `drone-agent/src/plugins/lsp/tools.ts` | Dispatch: `lsp__hover`, `lsp__completion`, etc. |
| 11 | `drone-agent/src/plugins/subagent/plugin.ts` | Tool name: `subagent__dispatch` |
| 12 | `drone-agent/src/plugins/mcp/index.ts` | MCP tool mounting: `serverId__toolName` |
| 13 | `drone-agent/src/plugins/self-improvement/index.ts` | Prompt fragments + tool names updated |
| 14 | `drone-agent/src/cli.ts` | Workflow parser: expects `__` separator |
| 15 | `drone-agent/src/runtime/builtin-commands.ts` | Dispatch: `exec__run` |
| 16 | `drone-agent/src/tui/app.tsx` | Event names: `exec__run`, `file__apply_diff`, `git__diff` |
| 17 | `drone-agent/src/index.tsx` | Tool name: `startup__status` |
| 18 | Multiple test files (15 files) | All hardcoded tool names updated |
| 19 | `drone-agent/README.md` | LSP and MCP tool naming docs updated |
| 20 | `drone-agent/AGENTS.md` | Workflow and tool name references updated |

## Validation

- `pnpm build` — passes
- `pnpm typecheck` — passes (2 pre-existing errors in drone-swarm-common/src/tls.ts, unrelated)
- `pnpm test` — 806 tests pass across 47 test files
- `pnpm lint` — 2 pre-existing errors in drone-swarm-common/src/tls.ts, unrelated

## Commit

`9efbdf0` — "feat: change tool name separator from dot to double underscore"