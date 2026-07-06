---
key: plugin-customizable-tool-render
tags:
  - tui
  - plugins
  - plan
  - tool-render
created: 2026-07-06T21:28:02.983Z
updated: 2026-07-06T21:28:02.983Z
---

# Plan: Plugin-Customizable Tool Render Components

## Summary

Allow plugins to optionally register a custom JSX component for rendering their tool call state in the TUI's tail region. When a plugin doesn't provide one, the existing default `ToolCallProgress` fallback is used. This also cleans up:
- The special-case formatting functions in `app.tsx` (`formatDiffResult`, `formatExecResult`, etc.) — removed since git gets its own component
- The `registration.logger.error(...)` catch block in `file__apply_diff` — removed as unnecessary noise now that errors surface through normal paths

## Dependencies

Step 1 (drone-core types) must be first — subsequent steps depend on the new types.
Steps 2–3 (type plumbing) can be done in any order after step 1.
Steps 4–5 (git component) can be done in parallel with step 6 (app.tsx rewrite).
Step 7 (file.ts cleanup) is independent.
Step 8 (validation) is last.

## Step 1: Add ToolRenderState type to drone-core

**File**: `drone-core/src/session-types.ts`

Add a new type before the `DroneConversationEvent` section:

```typescript
/** State passed to a custom tool render component in the TUI tail region. */
export type ToolRenderState = {
  name: string;
  arguments: Record<string, unknown>;
  /** Present when the tool has completed (success or error). */
  result?: string;
  status: 'running' | 'done' | 'error';
  /** TUI color scheme, cast to unknown to keep drone-core React-free. */
  scheme: unknown;
};
```

Re-export from `drone-core/src/index.ts`.

## Step 2: Add renderComponent to DroneToolDefinition

**File**: `drone-core/src/plugin-system.ts`

Add an optional field to `DroneToolDefinition`:

```typescript
export type DroneToolDefinition = {
  name: string;
  description: string;
  inputSchema?: DroneToolJsonSchema;
  defaultHidden?: boolean;
  execute: (input: Record<string, unknown>) => Promise<string>;
  /** Optional custom React component for rendering in the TUI tail region. */
  renderComponent?: (state: import('./session-types.js').ToolRenderState) => unknown;
};
```

The return type is `unknown` (not `ReactNode`) to keep drone-core React-free. The TUI casts to `ReactNode` at usage time.

## Step 3: Add getTool to DroneTuiOptions.engine pick

**File**: `drone-agent/src/tui/types.ts`

The `DroneTuiOptions.engine` pick already has `executeTool` and `listTools` but NOT `getTool` (which returns `DroneToolDefinition | undefined`). Add it:

```typescript
export type DroneTuiOptions = {
  engine: Pick<
    DronePluginEngine,
    | 'listTools'
    | 'listPlugins'
    | 'getRegisteredPluginCount'
    | 'getRegisteredToolCount'
    | 'getCapability'
    | 'runHooks'
    | 'executeTool'
    | 'getHelpSnippets'
    | 'renderPromptFragments'
    | 'getConfig'
    | 'dispatchSlashCommand'
    | 'setElicitation'
    | 'onConversationEvent'
    | 'runWorkflow'
    | 'getSlashCommands'
    | 'getTool'               // ← ADD
  >;
```

This is how the event listener will look up the `renderComponent` for each tool name during batch processing.

## Step 4: Create shared diff-format utility

**File**: `drone-agent/src/tui/shared/diff-format.ts` (new)

Extract `formatDiffResult`, `formatDiffOutput`, `tryParseJson`, and `ANSI` from `app.tsx` into a shared utility. Both `GitDiffBlock` and the `toEntry()` functions will use this:

```typescript
export const ANSI = { red: '\x1b[31m', green: '\x1b[32m', reset: '\x1b[0m' };
export function formatDiffResult(content: string): string { ... }
export function formatDiffOutput(diff: string): string { ... }
export function tryParseJson(raw: string): Record<string, unknown> | undefined { ... }
```

## Step 5: Create GitDiffBlock component

**File**: `drone-agent/src/tui/components/GitDiffBlock.tsx` (new)

A custom Ink component that receives `ToolRenderState` (with `scheme` cast to `DroneColorScheme`) and:
- Parses the JSON result to extract the `diff` field
- Renders each line with Ink's `<Text color={...}>`: green for `+`, red for `-`, neutral for headers/hunks/context
- Uses `wrap="wrap"` for proper soft-wrap color behavior

## Step 6: Register renderComponent on git__diff

**File**: `drone-agent/src/plugins/git.ts`

Add `renderComponent` to the `diff` tool registration:

```typescript
registration.registerTool({
  name: 'diff',
  description: 'Unstaged diff, or staged diff with staged=true.',
  inputSchema: { ... },
  renderComponent: (state: ToolRenderState) => <GitDiffBlock state={state} />,
  execute: async input => { ... },
});
```

Since `renderComponent` returns `unknown` and JSX compiles to `React.createElement` calls (plain objects), this works without any React dependency in drone-core. Both `GitDiffBlock` and the git plugin live in the same package (`drone-agent`).

## Step 7: Rewrite toolCallBatch/toolResultBatch handlers in app.tsx

**File**: `drone-agent/src/tui/app.tsx`

Changes:
1. In `toolCallBatch` handler: look up `opts.engine.getTool(tc.name)` and check `toolDef?.renderComponent`. If present, call it with `{ name, arguments, status: 'running', scheme: s as unknown }` and cast to `ReactNode`. Otherwise fall back to `<ToolCallProgress ... />`.
2. In `toolResultBatch` handler: same lookup for the result state `{ name, arguments, result, status: 'done'|'error', scheme }`.
3. Remove from `app.tsx`:
   - `ANSI` constant (moved to `diff-format.ts`)
   - `formatDiffResult` function (moved to `diff-format.ts`)
   - `formatDiffOutput` function (moved to `diff-format.ts`)
   - `tryParseJson` function (moved to `diff-format.ts`)
   - `formatExecResult` function (removed entirely — exec__run gets default preview)
   - `formatToolResult` function (removed entirely — no more special-casing tools)
   - `__testing.formatDiffResult` export (no longer needed)
4. The `toEntry()` functions for tool calls use `preview()` for non-git tools; for git diff, import `formatDiffResult` from the shared utility.

## Step 8: Remove file__apply_diff extra logging

**File**: `drone-agent/src/plugins/file.ts`

Remove the `registration.logger.error(...)` call in the catch block of the `file__apply_diff` tool's execute function. The error is already thrown and will surface through the normal error path (tail region shows `✗ file__apply_diff: error message`).

The catch block becomes a bare re-throw:
```typescript
} catch (err) {
  throw err;
}
```

Or just remove the try/catch entirely if the catch doesn't do anything else.

## Step 9: Validation

- Run `pnpm build` — must exit 0
- Run `pnpm lint` — must exit 0
- Run `pnpm test` — must pass (update any test referencing `App.__testing.formatDiffResult`)
- Check LSP diagnostics are clean on all modified files

## Files Modified

| File | Change |
|------|--------|
| `drone-core/src/session-types.ts` | Add `ToolRenderState` type |
| `drone-core/src/index.ts` | Re-export `ToolRenderState` |
| `drone-core/src/plugin-system.ts` | Add `renderComponent` to `DroneToolDefinition` |
| `drone-agent/src/tui/types.ts` | Add `getTool` to `DroneTuiOptions.engine` pick |
| `drone-agent/src/tui/shared/diff-format.ts` | **New** — `formatDiffResult`, `formatDiffOutput`, `ANSI`, `tryParseJson` |
| `drone-agent/src/tui/components/GitDiffBlock.tsx` | **New** — Ink component for git diff rendering |
| `drone-agent/src/plugins/git.ts` | Register `renderComponent` on `git__diff` |
| `drone-agent/src/tui/app.tsx` | Rewrite batch handlers, remove special-case functions, remove old imports |
| `drone-agent/src/plugins/file.ts` | Remove `registration.logger.error(...)` catch block |
| `drone-agent/test/...` | Update any test referencing `App.__testing.formatDiffResult` |

## Validation Criteria

- [ ] `pnpm build` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test` passes (all tests)
- [ ] LSP diagnostics are clean on all modified files
- [ ] `git__diff` renders with colored `+`/`-` in the tail region (Ink `<Text color={...}>`)
- [ ] `git__diff`'s static scrollback entry shows ANSI-colored diff text
- [ ] `file__apply_diff`, `exec__run`, and all other tools use the default `ToolCallProgress` fallback in the tail
- [ ] `file__apply_diff` errors no longer produce extra `registration.logger.error(...)` in logs