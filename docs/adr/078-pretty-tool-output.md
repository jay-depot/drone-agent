---
tags: [decision, tui, rendering]
related:
  [
    047-plugin-customizable-tool-render.md,
    079-pretty-tool-output-phase-2.md,
    080-subagent-dispatch-pretty-output.md,
    081-meta-tool-pretty-output.md,
    modules/drone-agent-tui.md,
  ]
---

# ADR 078: Pretty Tool Output — Phase 1 (Core Tools)

**Status**: Implemented (commit `d8207f8`, 2026-07-21)

## Context

The TUI tail region rendered all tool calls using the default `ToolCallProgress` component — a generic JSON-with-arrows display. The seven core workhorse tools (`exec__run`, `file__read`, `file__write`, `file__apply_diff`, `file__list`, `file__glob`, `search__text`) deserved purpose-built, human-readable render components.

Additionally, `exec__run` had no streaming output — the user saw nothing until the command completed, even for long-running commands.

## Decision

Create custom Ink render components for the seven core tools, and add genuine streaming output for `exec__run`.

### Infrastructure Changes

**`drone-core`** (`session-types.ts`):

- New `toolProgress` event kind in `DroneConversationEvent`
- `outputLines?: string[]` field on `ToolRenderState`
- `onProgress?: (chunk: string) => void` parameter on `DroneToolDefinition.execute`

**Runtime** (`plugin-engine.ts`, `conversation-service.ts`):

- `onProgress` threaded through `executeTool` and conversation service (emits `toolProgress` events)
- `exec.ts` streams stdout/stderr chunks via `onProgress` while still buffering `stdout`/`stderr` separately for the LLM return value
- `app.tsx` accumulates `outputLines` per tool call in a `Map<string, {id, lines, args}>` ref, re-renders the custom component on each `toolProgress` event, and passes accumulated lines into the final `ToolRenderState`

### Render Components (7 new files)

| Component            | File                                    | Behavior                                                                  |
| -------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| `ExecRunBlock`       | `tui/components/ExecRunBlock.tsx`       | `…/✓/✗ exec__run $ <command>` with streaming output lines                 |
| `FileReadBlock`      | `tui/components/FileReadBlock.tsx`      | Path + line range + up to 5 syntax-highlighted preview lines + `===`      |
| `FileWriteBlock`     | `tui/components/FileWriteBlock.tsx`     | `✓ Wrote <path>`                                                          |
| `FileApplyDiffBlock` | `tui/components/FileApplyDiffBlock.tsx` | `✓ <path>` + `+N -N across N hunk(s)`                                     |
| `FileListBlock`      | `tui/components/FileListBlock.tsx`      | Path header + `📁 dirname/` / `📄 filename` entries                       |
| `FileGlobBlock`      | `tui/components/FileGlobBlock.tsx`      | Pattern + matches + `(N matches)`                                         |
| `SearchTextBlock`    | `tui/components/SearchTextBlock.tsx`    | `pattern in path` + `file:line  content` rows + `(N matches) [truncated]` |

### Shared Extraction

`tui/shared/syntax-highlight.ts` — extracted lowlight instance, color maps, `renderHighlightedTree`, `extractTokenText`, `getTokenColor`, and `extToLang` from `Markdown.tsx` so `FileReadBlock` can reuse syntax highlighting.

### Tests

26 tests in `test/pretty-tool-output.test.tsx` covering all 7 components in running/done/error states, 5-line preview limit, match count singular/plural, truncated indicator.

## Consequences

### Positive

- Core tools now show meaningful, human-readable output in the TUI
- `exec__run` streams output in real-time
- Syntax highlighting shared between Markdown and file previews
- Infrastructure (`onProgress`, `outputLines`) reusable by future tools

### Negative

- Increased TUI component surface area (7 new components)
- `onProgress` adds complexity to the tool execution pipeline

## Related

- [047-plugin-customizable-tool-render](047-plugin-customizable-tool-render.md) — The plugin-customizable render component system that this builds on
- [079-pretty-tool-output-phase-2](079-pretty-tool-output-phase-2.md) — Phase 2: 12 more tools across 6 plugins
- [080-subagent-dispatch-pretty-output](080-subagent-dispatch-pretty-output.md) — Subagent dispatch TUI rendering
- [081-meta-tool-pretty-output](081-meta-tool-pretty-output.md) — Reusable list/mount/unmount meta-tool components
- [drone-agent-tui](../../drone-agent/src/tui/) — TUI module documentation
