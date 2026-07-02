---
key: file-apply-diff-unified-diff-v3
tags:
  []
created: 2026-07-02T01:29:49.890Z
updated: 2026-07-02T01:50:00.415Z
---

# Implementation Summary: Flat Unified Diff for `file__apply_diff`

## What changed

The `file__apply_diff` tool previously accepted a nested JSON structure with `hunks: [{ anchors, contextBefore, oldLines, newLines, contextAfter }]`. It now accepts a flat `patch: string` parameter in standard unified diff format (like `git diff` output).

## Files created

- **`drone-agent/src/shared/unified-diff-parser.ts`** — New module that parses unified diff strings into `HunkWithHints[]` (extends `PatchHunk` with `lineHint` and `sectionHeading`). Handles all edge cases: single/multi-hunk, pure insertion/deletion, section headings, no-newline markers, git file headers.
- **`drone-agent/test/unified-diff-parser.test.ts`** — 15 tests covering all parser edge cases.

## Files modified

- **`drone-agent/src/shared/patch-applier.ts`** — Added optional `lineHint` and `sectionHeading` fields to `PatchHunk`. Added hint-based search prioritization: lineHint sorts anchor candidates by proximity (window of ±15 lines); sectionHeading is tried as a soft anchor before falling back to full-file context matching. Both are soft hints — incorrect values never prevent a match.
- **`drone-agent/src/plugins/file.ts`** — Rewrote the `file__apply_diff` tool registration. New `inputSchema: { path, patch }` replaces `{ path, hunks, color }`. New `execute` handler calls `parseUnifiedDiff` then `applyPatch`. New `formatPatchError()` function produces error messages in unified-diff language ("the `-` lines didn't match") with a "re-read the file" nudge. Removed `isRecord` import. Bumped plugin version to `0.3.0`.
- **`drone-agent/test/file.test.ts`** — Updated round-trip integration tests from `{ path, hunks: [...] }` to `{ path, patch: "..." }`. Added 5 new tests: multi-hunk, insertion with context, pure deletion, empty patch rejection, no-hunks rejection.

## Validation

- `pnpm typecheck` passes (only pre-existing errors in unrelated test file)
- `pnpm test` passes — 850 tests across 49 files
- Tool output format is unchanged (`{ path, patched, summary, diff }`) — TUI unaffected
- Progressive whitespace permissiveness preserved (3-level fuzz cascade: exact → trailing whitespace → all whitespace)