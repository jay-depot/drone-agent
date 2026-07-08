---
key: tui-tail-scrollback-refactor-plan
tags:
  - tui
  - plan
  - refactor
  - scrollback
  - formatting
  - completed
created: 2026-07-08T04:15:55.717Z
updated: 2026-07-08T04:49:09.353Z
---

# Plan: TUI Tail → Scrollback Formatting Preservation — COMPLETED

## Status: DONE (2026-07-08)

## What changed
- types.ts: ChatEntry gained `node?: ReactNode`.
- NEW tui/shared/format.ts: single source of truth for PREVIEW_MAX, preview(), tryParseJson().
- ToolCallProgress.tsx / GitDiffBlock.tsx now import helpers from format.ts (removed local dupes).
- DELETED tui/shared/diff-format.ts (formatDiffResult/formatDiffOutput/ANSI no longer used; GitDiffBlock node renders the diff in scrollback).
- useTailRegion.ts: commitItem/commitAll attach `node: item.component` to the committed entry.
- AssistantMessageBlock.tsx: now renders via Markdown (takes scheme; color=scheme.info). app.tsx passes scheme={s} and commits assistantMessage as kind 'markdown'.
- app.tsx: dropped local PREVIEW_MAX/preview (import from format.ts), removed formatDiffResult import + git__diff special-case, single clearTail() on error (removed 3x redundant), markdown kind for assistant.
- ChatLog.tsx: renders `entry.node ?? renderEntry(entry, scheme)` inside <Static>.

## Surfaced a pre-existing bug
Markdown.tsx called `marked.parse()` which returns a STRING in marked v18; renderToken expects a token array → `tokens.map is not a function` crash. Fixed to `marked.lexer()`. Without this fix, assistant-message Markdown routing (the plan's headline) would crash the TUI at runtime. Now assistant messages render as real Markdown in tail + scrollback.

## Tests added (all passing)
- test/useTailRegion.test.tsx (5): node attached on commit; updateItem swaps node; commitAll; clear; throw on unknown.
- test/useChatLog.test.tsx (4): monotonic ids; log default plain; log explicit kind; order.
- test/ChatLog.test.tsx (3): node precedence over text fallback; renderEntry fallback; markdown-without-node.
- test/app-commit-flow.test.tsx (3): reasoning/tool/assistant commit; markdown render; error clears tail.
- Removed 2 stale tests in test/file.test.ts that imported the deleted diff-format.js.

## Validation
- pnpm typecheck ✅  pnpm lint ✅  pnpm test ✅ (1263 tests)  pnpm build ✅

## Flagged behavioral change (intended)
Tool-result scrollback entries now render the live component (ToolCallProgress/GitDiffBlock) with theme-driven color, not the old one-line `← name: preview` summary. Truncation preserved for scrollback (Q2).