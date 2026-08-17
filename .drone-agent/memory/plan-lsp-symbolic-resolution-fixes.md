---
key: plan-lsp-symbolic-resolution-fixes
tags:
  - completed
  - lsp
  - review-fix
created: 2026-08-17T15:04:40.172Z
updated: 2026-08-17T15:50:32.645Z
---

# Plan: Fix LSP Symbolic Resolution Issues (Review Follow-up)

## Summary

Fix 7 issues found during code review of the LSP symbolic resolution improvements. The most critical is wiring up the reference ID handshake — `storeReferences` is never called, making `referenceId` parameters non-functional. Also fix auto-expansion deduplication, add completion snippets, apply surroundingText to workspace symbols, remove dead code, and add missing refreshIfNeeded calls.

## Issues Being Fixed

1. **`storeReferences` is never called** — the "Resolve" half of the reference ID handshake is missing
2. **`completion` tool missing auto-expansion** — no snippet returned
3. **`buildAutoExpansion` deduplicates by file, not location** — multiple refs in same file lose snippets
4. **`resolveSymbolPosition` doesn't apply `surroundingText` to workspace symbols**
5. **`readFileSnippet` `column` parameter is unused** — dead code
6. **Diagnostics tool has unnecessary `surroundingText` in schema** — whole-file is the right granularity
7. **`go_to`, `inspect`, `completion`, `call_hierarchy` missing `refreshIfNeeded()`** — stale document state

## Design Decisions

- Custom error class `AmbiguousPositionError` in `drone-core/position-types.ts` (not LSP-specific, reusable by other tools)
- Each `AmbiguousMatch` includes `suggestedSurroundingText` — minimal unique line from context (line-level granularity, like file__apply_diff's reworked hunks)
- Context window: soft limit 5 lines, expand by 5 at a time, hard limit 30 lines before/after
- If no unique line found within hard limit, `suggestedSurroundingText` is `undefined`
- `AmbiguousMatch` carries `filePath` since workspace symbol matches can span multiple files

## Files to Change

### New: `drone-core/src/position-types.ts`
- `AmbiguousMatch` type: `{ filePath, line, column, context, suggestedSurroundingText }`
- `AmbiguousPositionError` class extends `Error` with `filePath` (or undefined for workspace ambiguity) and `matches: AmbiguousMatch[]`
- Private `suggestSurroundingText` helper: scans context lines for uniqueness across all matches, expands window from 5 up to 30 lines
- Private `buildAmbiguousMatches` helper: takes raw matches + file lines, computes suggestions

### `drone-core/src/index.ts`
- Re-export `AmbiguousPositionError`, `AmbiguousMatch` from `position-types.ts`

### `drone-agent/src/plugins/lsp/server.ts`
- Import `AmbiguousPositionError` and `AmbiguousMatch` from `drone-core`
- `resolveTextPosition`: throw `AmbiguousPositionError` instead of plain `Error` on ambiguity
- `resolveSymbolPosition`: throw `AmbiguousPositionError` for document symbol ambiguity; apply `surroundingText` to workspace symbol matches; throw `AmbiguousPositionError` for workspace symbol ambiguity
- `readFileSnippet`: remove unused `column` parameter
- `ServerManager` type: remove `column` from `readFileSnippet` signature

### `drone-agent/src/plugins/lsp/tools/editing.ts`
- `createRenameTool`: catch `AmbiguousPositionError`, call `storeReferences`, return reference IDs with crib sheets (matches + suggestedSurroundingText + snippets)
- `createCodeActionTool`: catch `AmbiguousPositionError`, call `storeReferences`, return reference IDs with crib sheets

### `drone-agent/src/plugins/lsp/tools/navigation.ts`
- `buildAutoExpansion`: remove `seenFiles` deduplication, use `seenKeys` instead
- `createGoToTool`: add `await server.refreshIfNeeded()` before `resolveAtPosition`

### `drone-agent/src/plugins/lsp/tools/completion.ts`
- `createCompletionTool`: add `await server.refreshIfNeeded()` and query-position snippet (same as `inspect`)
- `createInspectTool`: add `await server.refreshIfNeeded()`

### `drone-agent/src/plugins/lsp/tools/hierarchy.ts`
- `createCallHierarchyTool`: add `await server.refreshIfNeeded()`

### `drone-agent/src/plugins/lsp/tools/diagnostics.ts`
- Remove `surroundingText` from schema and description

### `drone-agent/test/lsp-ergonomics.test.ts`
- Add tests for `AmbiguousPositionError` being thrown with structured data
- Add tests for rename/code_action returning reference IDs on ambiguity
- Add tests for `suggestedSurroundingText` correctness
- Update mock servers to remove `column` from `readFileSnippet`
- Remove `surroundingText` test from diagnostics schema test

## Validation Results ✅ ALL PASSED

- [x] `rename` tool, when given ambiguous text/symbol, returns reference IDs with snippets and `suggestedSurroundingText`
- [x] `code_action` tool, when given ambiguous text/symbol, returns reference IDs with snippets and `suggestedSurroundingText`
- [x] `rename` tool, when given a `referenceId` from a previous ambiguous resolution, resolves and executes
- [x] `completion` tool returns a `snippet` field with code context around the query position
- [x] `buildAutoExpansion` returns snippets for all locations, not just one per file
- [x] `resolveSymbolPosition` applies `surroundingText` to workspace symbol matches
- [x] `readFileSnippet` has no `column` parameter
- [x] `diagnostics` tool schema has no `surroundingText` field
- [x] `go_to`, `inspect`, `completion`, `call_hierarchy` all call `refreshIfNeeded()` before position resolution
- [x] `AmbiguousPositionError` is exported from `drone-core`
- [x] `pnpm -r run lint` and `pnpm -r run build` pass
- [x] LSP diagnostics for the plugin remain clean
- [x] All existing tests pass (1933 tests)
- [x] New tests pass (34 LSP ergonomics tests)