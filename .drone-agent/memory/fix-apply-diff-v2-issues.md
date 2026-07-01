---
key: fix-apply-diff-v2-issues
tags:
  []
created: 2026-07-01T23:25:01.755Z
updated: 2026-07-01T23:36:12.345Z
---

# Fix `file__apply_diff` V2 Issues Plan

**Status**: Completed (2026-07-01)

## Implemented Fixes

### Step 1: Fixed fuzzy anchor-chain narrowing cascade
- **File**: `drone-agent/src/shared/patch-applier.ts`
- **Change**: Saved `firstAnchorCandidates = [...candidates]` before narrowing, so fuzzy fallback (levels 1 and 100) retries from the original first-anchor matches instead of passing an empty array
- **Why**: When exact multi-anchor narrowing (level 0) fails, `candidates` is `[]`. Fuzzy fallback received this empty array, making it a no-op

### Step 2: Fixed TUI `formatDiffResult` to recognize `patched` field
- **File**: `drone-agent/src/tui/app.tsx`
- **Change**: Updated check from `obj.written === true` to `obj.written === true || obj.patched === true`
- **Why**: `file__write` returns `written: true`, `file__apply_diff` returns `patched: true`

### Step 3: Always return plain-text diff from `file__apply_diff`
- **File**: `drone-agent/src/plugins/file.ts`
- **Change**: Removed `supportsColor` import and color logic; always calls `renderDiffV2(filePath, diffHunks, false)` and returns `diffResult.plain`
- **Why**: ANSI codes in the tool result confuse the LLM and break TUI line classification

### Step 4: Removed redundant re-application via `patchedLines`
- **Files**: `patch-applier.ts` + `file.ts`
- **Change**: Added `patchedLines: string[]` to `PatchResult` interface; `applyPatch` now returns `patchedLines: workingLines` directly; `file.ts` uses `result.patchedLines` instead of re-applying hunks manually
- **Why**: Eliminates position tracking code that duplicated `applyPatch`'s internal logic

### Step 5: Added round-trip integration tests
- **File**: `drone-agent/test/file.test.ts`
- **Tests added**: (1) Full tool execution verifying JSON response has `patched: true` and plain-text diff, (2) TUI `formatDiffResult` recognizes `patched` field, (3) TUI `formatDiffResult` still works with `written` field
- **Added**: Exported `formatDiffResult` via `__testing` from `app.tsx` for direct test access

### Commit: `2f377a0`

## Validation
- All 830 tests pass (48 test files, was 827 before)
- Zero LSP errors in changed files
- Pre-existing LSP errors in unchanged files (llm-provider-switching.test.ts) unaffected