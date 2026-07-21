---
key: subagent-dispatch-pretty-output
tags:
  - plan
  - tui
  - pretty-output
  - subagent
  - complete
created: 2026-07-21T20:33:56.724Z
updated: 2026-07-21T20:39:54.514Z
---

# Plan: subagent-dispatch-pretty-output

## Summary

Add a custom TUI render component for `subagent__dispatch` that shows the kickoff prompt (markdown-rendered), a thin horizontal rule divider, and a live-updating "last subagent action" line while the subagent runs. When the subagent completes, the last action naturally transitions into the subagent's return result (markdown-rendered).

Also adds real-time NDJSON event parsing to the subagent's stdout stream so the parent agent can monitor subagent progress as it happens — a capability that will be useful for other features later.

## Status: COMPLETE

All steps implemented and validated. Commit `ce5eb8b`.

### What was built

**Real-time NDJSON parsing (plugin.ts):**
- Added `onProgress` parameter to the `dispatch` tool's `execute` function
- Each stdout line from the subagent is parsed as NDJSON and converted to a progress string:
  - `{kind:"reasoning", content:"..."}` → `reasoning:<text>`
  - `{kind:"toolCall", name:"...", input:{...}}` → `tool:<name>(<truncated-args>)`
  - `{kind:"assistantMessage", content:"..."}` → `msg:<truncated-content>`
  - `{kind:"return", result:"..."}` → `done:<result>`
- Args truncated to ~80 chars, message content to ~120 chars

**SubagentDispatchBlock component (new file):**
- Running state: `… subagent__dispatch - <persona>` header, markdown-rendered kickoff, divider, and last action
- Done state: `✓` header, markdown-rendered kickoff, divider, and markdown-rendered result
- Error state: `✗` header, markdown-rendered kickoff, divider, and error message
- Last action rendering: reasoning in gray, tool calls with `⚡` prefix, messages as plain text, done as markdown

**Tests (10 tests):**
- Running state with/without persona
- Reasoning, tool call, and assistant message as last action
- Done state with result and with error result
- Error state with and without result message
- Most recent output line shown as last action

### Validation
- `pnpm typecheck` ✅
- `pnpm lint:eslint` + `pnpm lint:prettier` ✅
- `pnpm build` ✅
- `pnpm test` — 102 test files, 1574 tests, all passing ✅
- LSP diagnostics clean ✅