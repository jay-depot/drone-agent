---
tags: [decision, tui, scrollback, formatting, refactor]
related:
  [
    046-tui-tail-region-refactor.md,
    047-plugin-customizable-tool-render.md,
    modules/drone-agent-tui.md,
  ]
---

# ADR 055: TUI Tail → Scrollback Formatting Preservation

**Status**: Implemented

**Date**: 2026-07-08

## Context

The tail region (ADR 046) pre-renders in-flight content as live React components and commits it atomically to the `<Static>` scrollback. But the commit step threw away the rich formatting: committed `ChatEntry` values only carried `kind` + `text`, so the scrollback re-rendered entries through a plain fallback (`renderEntry`) that lost the live component's color, structure, and (for the assistant message) Markdown. Tool results in scrollback collapsed to a one-line `← name: preview` summary instead of the live component.

This was a formatting-regression gap between the live tail and the persistent scrollback. The user reported that scrollback did not preserve the formatting seen in the tail.

## Decision

**Carry the rendered `ReactNode` into the committed entry, and render it in scrollback when present.**

### 1. `ChatEntry.node`

`types.ts` `ChatEntry` gained an optional `node?: ReactNode` field. The tail region's `commitItem`/`commitAll` now attach `item.component` (the live `ReactNode`) onto the committed entry as `node`. `ChatLog` renders `entry.node ?? renderEntry(entry, scheme)` inside `<Static>` — so the scrollback shows the _exact same_ component the tail showed, with full theme color and structure, and only falls back to the plain `renderEntry` path when no node is attached (e.g. legacy/plain entries).

### 2. Single source of truth for preview/JSON helpers

- **NEW** `tui/shared/format.ts`: owns `PREVIEW_MAX`, `preview()`, and `tryParseJson()` — previously duplicated in `app.tsx` and the diff tool. `ToolCallProgress.tsx` / `GitDiffBlock.tsx` now import these from `format.ts` (removed local dupes).
- **DELETED** `tui/shared/diff-format.ts`: `formatDiffResult`/`formatDiffOutput`/the `ANSI` constant are no longer used — `GitDiffBlock` renders the diff as a committed `node` directly in scrollback (theme-colored), so the ANSI/string formatting path was dead code. Test files that imported the deleted module were removed (`test/file.test.ts` had 2 stale tests).

### 3. Assistant messages render as Markdown in tail + scrollback

`AssistantMessageBlock.tsx` now renders the assistant message body through `Markdown` (taking the color scheme, `color={scheme.info}`). `app.tsx` passes `scheme={s}` and commits the assistant message as `kind: 'markdown'`. Because the committed entry now carries `node` (the live `AssistantMessageBlock`), the scrollback shows the same Markdown rendering the tail did.

### 4. Pre-existing crash fixed en route

`Markdown.tsx` called `marked.parse()`, which in marked v18 returns a **string**, but `renderToken` expected a token **array** → `tokens.map is not a function` at runtime. Fixed to `marked.lexer()` (returns the token array). Without this fix, routing assistant messages through Markdown (the headline of this plan) would crash the TUI at runtime — so the fix is bundled into the same change.

### 5. `app.tsx` cleanup

- Dropped local `PREVIEW_MAX`/`preview` (imported from `format.ts`).
- Removed the `formatDiffResult` import and the `git__diff` special-case in the scrollback entry builder.
- Collapsed three redundant `clearTail()` error paths into a single `clearTail()` on error.
- Assistant message committed as `kind: 'markdown'`.

## Behavioral change (intended)

Tool-result scrollback entries now render the **live component** (`ToolCallProgress` for default tools, `GitDiffBlock` for `git__diff`) with theme-driven color, not the old one-line `← name: preview` summary. Scrollback truncation (for very long entries) is preserved via the `preview()` cap (Q2 from planning).

## Tests added (all passing)

- `test/useTailRegion.test.tsx` (5): `node` attached on commit; `updateItem` swaps node; `commitAll`; `clear`; throws on unknown id.
- `test/useChatLog.test.tsx` (4): monotonic ids; `log` default plain; `log` explicit kind; order.
- `test/ChatLog.test.tsx` (3): node precedence over text fallback; `renderEntry` fallback; markdown-without-node.
- `test/app-commit-flow.test.tsx` (3): reasoning/tool/assistant commit; markdown render; error clears tail.
- Removed 2 stale tests in `test/file.test.ts` that imported the deleted `diff-format.ts`.

## Validation

`pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` ✅ (1263 tests) · `pnpm build` ✅.

## Implementation

- **Commits**: `809e904` (docs: plan + planning insight), `f9e74ed` (refactor: preserve tail formatting in `<Static>` scrollback)
- **Files**: `drone-agent/src/tui/types.ts`, `drone-agent/src/tui/shared/format.ts` (new), `drone-agent/src/tui/shared/diff-format.ts` (deleted), `drone-agent/src/tui/components/{AssistantMessageBlock, ChatLog, GitDiffBlock, ToolCallProgress}.tsx`, `drone-agent/src/tui/components/Markdown.tsx`, `drone-agent/src/tui/hooks/useTailRegion.ts`, `drone-agent/src/tui/app.tsx`, `drone-agent/test/*`
- Project memory `tui-tail-scrollback-refactor-plan` (completed) deleted after ingest.

## Related

- [046-tui-tail-region-refactor](046-tui-tail-region-refactor.md) — The tail region this builds on (atomic commit of live components).
- [047-plugin-customizable-tool-render](047-plugin-customizable-tool-render.md) — Custom tool render components (`GitDiffBlock`) now also render in scrollback via the carried `node`.
- [drone-agent-tui](../../drone-agent/src/tui/) — TUI module page (updated for `node` + `format.ts`).
