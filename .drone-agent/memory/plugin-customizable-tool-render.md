---
key: plugin-customizable-tool-render
tags:
  - tui
  - plugins
  - plan
  - tool-render
  - complete
created: 2026-07-06T21:28:02.983Z
updated: 2026-07-06T21:43:30.938Z
---

# Plan: Plugin-Customizable Tool Render Components

## Summary

Allow plugins to optionally register a custom JSX component for rendering their tool call state in the TUI's tail region. When a plugin doesn't provide one, the existing default `ToolCallProgress` fallback is used. This also cleans up:
- The special-case formatting functions in `app.tsx` (`formatDiffResult`, `formatExecResult`, etc.) — removed since git gets its own component
- The `registration.logger.error(...)` catch block in `file__apply_diff` — removed as unnecessary noise now that errors surface through normal paths

**Status: COMPLETE** — All 9 steps implemented, committed as `1000ad9`.

## What Was Built

1. **ToolRenderState type** in drone-core — state passed to custom render components
2. **renderComponent field** on DroneToolDefinition — optional, returns unknown to keep drone-core React-free
3. **getTool in TUI options** — the event listener uses this to look up renderComponent per tool
4. **Shared diff-format utility** — ANSI-colored diff formatting for the static scrollback
5. **GitDiffBlock component** — Ink component rendering git diff with colored +/- in the tail region
6. **git__diff registration** — renderComponent set to GitDiffBlock
7. **Rewritten app.tsx** — toolCallBatch/toolResultBatch handlers look up renderComponent, fall back to ToolCallProgress. All special-case functions (formatDiffResult, formatExecResult, formatToolResult, etc.) removed.
8. **file__apply_diff cleanup** — removed registration.logger.error catch block
9. **Validation** — pnpm build, lint, test all pass. 1213 tests passing. LSP diagnostics clean.

## Key Design Decision

The `renderComponent` function returns `unknown` rather than `ReactNode` to keep `drone-core` free of React dependencies. Plugins return JSX directly (JSX compiles to `React.createElement` calls, which are compatible with `unknown`). The TUI casts the result to `ReactNode` at usage time.