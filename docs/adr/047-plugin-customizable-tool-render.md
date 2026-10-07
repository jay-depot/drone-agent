---
tags: [decision, tui, plugins, rendering]
related: [046-tui-tail-region-refactor.md, 055-tui-tail-scrollback-formatting-preservation.md, modules/drone-agent-tui.md, entities/Session.md, flows/tool-call-loop.md]
---

# ADR 047: Plugin-Customizable Tool Render Components

**Status**: Implemented (commit `1000ad9`, 2026-07-06)

## Context

The TUI tail region rendered all tool calls using the same default `ToolCallProgress` component — a generic JSON-with-arrows display showing the tool name, arguments, and a truncated result preview. Some tools had special-case formatting logic hardcoded in `app.tsx`:

- `formatDiffResult`/`formatDiffOutput` — ANSI-colored diff display for `git__diff` and `file__apply_diff`
- `formatExecResult` — full command + output display for `exec__run`
- `formatToolResult` — routing function that dispatched to the above

This was brittle: every new tool with custom display needed a new special case in `app.tsx`. Additionally, `file__apply_diff` had a `registration.logger.error(...)` catch block that was noisy and unnecessary now that errors surface through the normal error path.

## Decision

Allow plugins to optionally register a custom JSX component for rendering their tool call state in the TUI's tail region. When a plugin doesn't provide one, the existing default `ToolCallProgress` fallback is used.

### New Types

**`ToolRenderState`** in `drone-core/src/session-types.ts`:

```typescript
export type ToolRenderState = {
  name: string;
  arguments: Record<string, unknown>;
  result?: string;       // Present when completed (success or error)
  status: 'running' | 'done' | 'error';
  scheme: unknown;       // DroneColorScheme, cast to unknown to keep drone-core React-free
};
```

**`renderComponent`** on `DroneToolDefinition` in `drone-core/src/plugin-system.ts`:

```typescript
export type DroneToolDefinition = {
  // ... existing fields ...
  renderComponent?: (state: ToolRenderState) => unknown;
};
```

The return type is `unknown` (not `ReactNode`) to keep drone-core React-free. JSX compiles to `React.createElement` calls (plain objects), which are compatible with `unknown`. The TUI casts to `ReactNode` at usage time.

### Git Diff Component

The `git__diff` tool was the first consumer. A custom `GitDiffBlock` Ink component renders diff output with colored `+`/`-` indicators using the TUI color scheme.

The `formatDiffResult`/`formatDiffOutput`/`tryParseJson` functions were originally extracted from `app.tsx` into a shared utility (`tui/shared/diff-format.ts`) so both the tail component (Ink-colored) and the static scrollback `toEntry()` (ANSI-colored) could use them. **Per ADR 055, `diff-format.ts` was deleted** — `GitDiffBlock` now renders the diff directly in the scrollback as the committed `node` (theme-colored), so the ANSI/string path became dead code. The surviving shared helpers (`tryParseJson`/`preview`/`PREVIEW_MAX`) moved to `tui/shared/format.ts`.

### Rewritten Batch Handlers

The `toolCallBatch` and `toolResultBatch` event handlers in `app.tsx` now look up each tool's `renderComponent` via `opts.engine.getTool(tc.name)`. If a custom render component is registered, it's called with the current state; otherwise, the default `ToolCallProgress` is used.

### Removed Special-Case Code

The following were removed from `app.tsx`:
- `ANSI` constant, `formatDiffResult`, `formatDiffOutput`, `tryParseJson` (moved to shared utility)
- `formatExecResult` (removed entirely — `exec__run` gets default preview)
- `formatToolResult` (removed entirely — no more special-casing tools)
- `__testing.formatDiffResult` export (no longer needed)
- `tui/shared/diff-format.ts` itself was later removed (ADR 055); `GitDiffBlock` renders the diff node in scrollback instead of via ANSI strings.

### `file__apply_diff` Cleanup

The `registration.logger.error(...)` catch block in `file__apply_diff` was removed. The outer `try/catch` was also removed since it only contained the logger call and a re-throw. The error is already thrown and surfaces through the normal error path (tail region shows `✗ file__apply_diff: error message`).

## Consequences

### Positive

- **Extensible**: Any plugin can now register a custom render component for its tools without touching `app.tsx`
- **Cleaner app.tsx**: Removed ~120 lines of special-case formatting logic
- **Shared utility**: `tryParseJson`/`preview` now live in a single location (`tui/shared/format.ts`) used by both tail and scrollback rendering
- **Cleaner error handling**: `file__apply_diff` no longer logs redundant error information

### Negative

- **Type casting**: The `scheme` field and return type require `as unknown`/`as ReactNode` casts at the usage site
- **Plugin dependency**: Plugins that register `renderComponent` must import the TUI component (acceptable since both are in the same package)

### Testing

Updated existing tests in `file.test.ts` to import `formatDiffResult` from the new shared utility instead of `App.__testing`.

## Related

- [[046-tui-tail-region-refactor]] — The tail region that hosts these render components
- [[055-tui-tail-scrollback-formatting-preservation]] — How `GitDiffBlock` (and other components) now render in scrollback via the carried `node`; `diff-format.ts` deletion
- [[modules/drone-agent-tui]] — TUI module documentation
- [[entities/Session]] — `ToolRenderState` and `DroneConversationEvent` types
