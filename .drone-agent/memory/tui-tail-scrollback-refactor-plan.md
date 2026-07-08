---
key: tui-tail-scrollback-refactor-plan
tags:
  - tui
  - plan
  - refactor
  - scrollback
  - formatting
created: 2026-07-08T04:15:55.717Z
updated: 2026-07-08T04:15:55.717Z
---

# Plan: TUI Tail → Scrollback Formatting Preservation

## Summary
Tail region renders live React components (reasoning, tool calls, assistant messages) and commits them to `<Static>` via `commitItem()` → `toEntry()`, which currently returns only a plain `{text,kind}` string. The rendered box is discarded, losing color/structure. Fix: add `node?: ReactNode` to `ChatEntry`; `commitItem` injects the item's live `component` into the entry; `ChatLog` renders `entry.node` inside `<Static>` when present (fallback to `renderEntry(text)` for plain `log()` lines). Assistant messages route through `Markdown` (the dead `markdown` kind). Dedup `preview`/`tryParseJson`/diff helpers into `tui/shared/format.ts`; delete `diff-format.ts`. Add tests.

## Decisions (resolved with user)
- Q1: Full refactor (node snapshot; assistant = Markdown).
- Q2: Keep truncating tool results in scrollback for now (git diff full via GitDiffBlock; generic keep ToolCallProgress caps).
- Q3: Full dedupe now into `tui/shared/format.ts`; delete `diff-format.ts`.
- Q4: Add unit tests (useTailRegion, useChatLog), ChatLog node-precedence test, App commit-flow integration test.

## Behavior change to flag
Tool-result scrollback entries will look like the live ToolCallProgress/GitDiffBlock (status glyph + colored args/result), NOT the old one-line `← name: preview` summary. Visible change, intended.

## Steps
1. types.ts: add `node?: ReactNode` to ChatEntry; `import type { ReactNode } from 'react'`.
2. NEW tui/shared/format.ts: export PREVIEW_MAX, preview(text,max?), tryParseJson(raw).
3. ToolCallProgress.tsx: import preview/PREVIEW_MAX from format.ts; drop locals.
4. GitDiffBlock.tsx: import tryParseJson from format.ts; drop local; keep renderDiffLines.
5. DELETE tui/shared/diff-format.ts (formatDiffResult/formatDiffOutput/ANSI unused after refactor).
6. useTailRegion.ts: commitItem & commitAll return `{ ...item.toEntry(), node: item.component }`.
7. AssistantMessageBlock.tsx: render via Markdown (add scheme prop, color=scheme.info); app.tsx call sites pass scheme={s}; toEntry kind='markdown'.
8. app.tsx: drop local PREVIEW_MAX/preview (import from format.ts); remove formatDiffResult import + git__diff special-case in toolResultBatch; assistant toEntry kind='markdown'; error case = single clearTail() + one ref reset (remove 3x redundant).
9. ChatLog.tsx: Static map renders `entry.node ?? renderEntry(entry, scheme)`.
10-12. Tests: useTailRegion.test.tsx, useChatLog.test.tsx, ChatLog.test.tsx (node precedence over text), App commit-flow test (fire reasoning→reasoningComplete→toolCallBatch→toolResultBatch→assistantMessage→assistantMessageComplete; assert lastFrame scrollback).
13. Reviewer: fidelity + no regressions + dedup complete.
14. pnpm typecheck && pnpm lint && pnpm test && pnpm build.

## Validation
- LSP clean / pnpm typecheck pass.
- pnpm lint pass.
- pnpm test pass (new tests included).
- pnpm build pass.
- Assistant=Markdown in tail+scrollback; tool results render live component (color preserved); reasoning colored+wrapped.
- No preview/tryParseJson/formatDiffResult duplication; diff-format.ts deleted.