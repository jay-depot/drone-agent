---
key: pretty-tool-output
tags:
  []
created: 2026-07-21T19:03:11.132Z
updated: 2026-07-21T19:20:16.472Z
---

# Plan: pretty-tool-output

## Summary

Replace the generic `ToolCallProgress` JSON-blob fallback in the TUI with purpose-built, human-readable render components for the seven core workhorse tools: `exec__run`, `file__read`, `file__write`, `file__apply_diff`, `file__list`, `file__glob`, and `search__text`.

Also adds genuine streaming output for `exec__run` via a new `toolProgress` conversation event type, a progress callback on `DroneToolDefinition.execute`, and an `outputLines` accumulator on `ToolRenderState`.

Branch: `pretty-tool-output`

## Status: COMPLETE

All 15 steps implemented and validated. Commit `d8207f8`.

### What was built

**Infrastructure (drone-core):**
- New `toolProgress` event kind in `DroneConversationEvent`
- `outputLines?: string[]` field on `ToolRenderState`
- `onProgress?: (chunk: string) => void` parameter on `DroneToolDefinition.execute`

**Infrastructure (drone-agent runtime):**
- `onProgress` threaded through `plugin-engine.ts` (`executeTool`) and `conversation-service.ts` (emits `toolProgress` events)
- `exec.ts` streams stdout/stderr chunks via `onProgress` while still buffering `stdout`/`stderr` separately for the LLM return value
- `app.tsx` accumulates `outputLines` per tool call in a `Map<string, {id, lines, args}>` ref, re-renders the custom component on each `toolProgress` event, and passes accumulated lines into the final `ToolRenderState`

**Render components (7 new files):**
- `ExecRunBlock.tsx` — `…/✓/✗ exec__run $ <command>` with streaming output lines
- `FileReadBlock.tsx` — path + line range + up to 5 syntax-highlighted preview lines + `===`
- `FileWriteBlock.tsx` — `✓ Wrote <path>`
- `FileApplyDiffBlock.tsx` — `✓ <path>` + `+N -N across N hunk(s)`
- `FileListBlock.tsx` — path header + `📁 dirname/` / `📄 filename` entries
- `FileGlobBlock.tsx` — pattern + matches + `(N matches)`
- `SearchTextBlock.tsx` — `pattern in path` + `file:line  content` rows + `(N matches) [truncated]`

**Shared extraction:**
- `tui/shared/syntax-highlight.ts` — extracted lowlight instance, color maps, `renderHighlightedTree`, `extractTokenText`, `getTokenColor`, and `extToLang` from `Markdown.tsx` so `FileReadBlock` can reuse syntax highlighting

**Tests:**
- `test/pretty-tool-output.test.tsx` — 26 tests covering all 7 components in running/done/error states, 5-line preview limit, match count singular/plural, truncated indicator

### Validation
- `pnpm typecheck` ✅
- `pnpm lint:eslint` + `pnpm lint:prettier` ✅
- `pnpm build` ✅
- `pnpm test` — 100 test files, 1512 tests, all passing ✅
- LSP diagnostics clean ✅