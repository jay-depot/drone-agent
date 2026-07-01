---
key: fix-apply-diff-v2-issues
tags:
  []
created: 2026-07-01T23:25:01.755Z
updated: 2026-07-01T23:25:01.755Z
---

# Fix `file__apply_diff` V2 Issues Plan

**Status**: Ready for execution

## Summary

The V2 redesign of `file__apply_diff` (commit `b4adc66`, 2026-07-01) replaced line-number-based hunks with content-anchor-based patches. Analysis found 5 concrete issues — 1 high-severity (broken fuzzy fallback in anchor chain narrowing), 2 medium-severity (TUI display bugs), and 2 low-severity (ANSI noise in LLM context, test coverage gap).

## Validation Criteria

1. All existing tests pass (`pnpm test`)
2. No new LSP diagnostics errors in changed files
3. TUI displays a clean "✓ Applied diff to ..." message when `file__apply_diff` succeeds
4. TUI diff display shows correct `+`/`-`/`@@` prefix indicators for additions, deletions, and hunk headers
5. The `diff` field in the tool result contains only plain text (no ANSI escape codes)
6. Multi-anchor hunks with whitespace differences in subsequent anchors successfully apply (fuzzy fallback works)
7. All existing patch-applier unit tests still pass

## Steps

---

### Step 1: Fix the fuzzy anchor-chain narrowing cascade

**Why**: When `narrowByAnchors` with exact matching (fuzz level 0) fails, `candidates` is already `[]`. The subsequent fuzzy fallback calls receive this empty array and produce empty results — the fuzzy fallback is a no-op. This makes multi-anchor disambiguation unreliable when subsequent anchors have whitespace differences.

**File**: `drone-agent/src/shared/patch-applier.ts`

**Change**: In the `applyPatch` function, around lines 320-334, save `candidates` before narrowing and use the saved copy for each fuzz level attempt:

**Current code** (lines 318-334):
```typescript
// Narrow by subsequent anchors
if (anchors.length > 1) {
  candidates = narrowByAnchors(workingLines, anchors, 0, candidates);
  if (candidates.length === 0) {
    // Try fuzzy narrowing
    candidates = narrowByAnchors(workingLines, anchors, 1, candidates);
  }
  if (candidates.length === 0) {
    candidates = narrowByAnchors(workingLines, anchors, 100, candidates);
  }
}
```

**Replace with**:
```typescript
// Narrow by subsequent anchors
if (anchors.length > 1) {
  // Save first-anchor candidates so fuzzy fallback can retry from scratch
  const firstAnchorCandidates = [...candidates];
  candidates = narrowByAnchors(workingLines, anchors, 0, firstAnchorCandidates);
  if (candidates.length === 0) {
    candidates = narrowByAnchors(workingLines, anchors, 1, firstAnchorCandidates);
  }
  if (candidates.length === 0) {
    candidates = narrowByAnchors(workingLines, anchors, 100, firstAnchorCandidates);
  }
}
```

---

### Step 2: Fix TUI `formatDiffResult` to recognize `patched` field

**Why**: The TUI checks for `obj.written === true` (the key used by `file__write`), but `file__apply_diff` returns `{ patched: true }`. The success check never matches, so the TUI falls through to the generic rendering path.

**File**: `drone-agent/src/tui/app.tsx`

**Change**: Update the JSON parsing branch in `formatDiffResult` (around line 107) to check for either `written` or `patched`:

**Current code** (lines 107-114):
```typescript
if (obj.path !== undefined && obj.written === true) {
  return `✓ Applied diff to ${obj.path}`;
}
// If it's a git diff result, it might have a 'diff' field
if (obj.diff && typeof obj.diff === 'string') {
  return formatDiffOutput(obj.diff);
}
```

**Replace with**:
```typescript
if (obj.path !== undefined && (obj.written === true || obj.patched === true)) {
  return `✓ Applied diff to ${obj.path}`;
}
// If it's a git diff result, it might have a 'diff' field
if (obj.diff && typeof obj.diff === 'string') {
  return formatDiffOutput(obj.diff);
}
```

---

### Step 3: Always return plain-text diff from `file__apply_diff` (fixes ANSI noise in LLM context + TUI mis-classification)

**Why**: The tool result is consumed by two consumers: the LLM (which should receive clean text, not ANSI escape codes) and the TUI's `formatDiffResult`/`formatDiffOutput` (which classify lines by their first character — `+`, `-`, `@@` — but this fails when lines are prefixed with ANSI escape sequences). By always returning `plain` text, both problems are solved: the LLM gets clean text, and the TUI's line classification works correctly.

**File**: `drone-agent/src/plugins/file.ts`

**Change**: In the `file__apply_diff` execute function, around line 362, always use `diffResult.plain`:

**Current code** (lines 359-363):
```typescript
const useColor = input.color !== false && supportsColor();
const diffResult = renderDiffV2(filePath, diffHunks, useColor);
const diffOutput = useColor ? diffResult.colored : diffResult.plain;
```

**Replace with**:
```typescript
// Always use plain text — the diff goes to both the LLM (which shouldn't see
// ANSI codes) and the TUI (which does its own coloring in formatDiffOutput).
const diffResult = renderDiffV2(filePath, diffHunks, false);
const diffOutput = diffResult.plain;
```

Note: The `color` input parameter can be kept in the schema for backward compatibility but is effectively ignored. This is fine — the TUI handles coloring.

---

### Step 4: Remove redundant re-application of hunks in file.ts

**Why**: The `applyPatch` function already applies hunks to its internal `workingLines` copy. The code in `file.ts` then reconstructs the same logic by re-applying the hunks using `appliedAtLine` positions. This is redundant and makes the code harder to follow.

**File**: `drone-agent/src/plugins/file.ts`

**Change**: Replace the manual re-application (lines 382-392) with using the already-patched result from `applyPatch`. The `applyPatch` function returns a `PatchResult` but discards the modified lines. We need to add a `patchedLines` field to `PatchResult`, or simply read the lines from the file that `applyPatch` writes internally. 

Actually, `applyPatch` works on a copy internally and returns `appliedHunks` with positions, but doesn't return the modified content. The simplest approach: modify `applyPatch` to also return the modified lines, then use those in `file.ts`.

**Sub-step 4a**: Update `PatchResult` in `drone-agent/src/shared/patch-applier.ts`:

Add a `patchedLines` field:
```typescript
export interface PatchResult {
  /** Whether all hunks were applied successfully */
  success: boolean;
  /** Hunks that were successfully applied */
  appliedHunks: AppliedHunk[];
  /** Hunks that failed to apply */
  errors: PatchError[];
  /** The resulting lines after all successful hunks are applied */
  patchedLines: string[];
}
```

**Sub-step 4b**: At the end of `applyPatch` (before the return), add:
```typescript
return {
  success: errors.length === 0,
  appliedHunks,
  errors,
  patchedLines: workingLines,
};
```

**Sub-step 4c**: In `file.ts`, remove the manual re-application (lines 375-392) and use `result.patchedLines` instead:

Replace:
```typescript
// Reconstruct the final content by applying hunks bottom-up
// using the positions from the successful applyPatch call.
const workingLines = [...lines];
const sortedHunks = result.appliedHunks
  .map((ah, i) => ({ ah, hunk: patchHunks[i] }))
  .sort((a, b) => b.ah.appliedAtLine - a.ah.appliedAtLine);

for (const { ah, hunk } of sortedHunks) {
  const idx = ah.appliedAtLine - 1; // Convert to 0-based
  workingLines.splice(idx, hunk.oldLines.length, ...hunk.newLines);
}

try {
  await writeFile(filePath, workingLines.join('\n'), 'utf-8');
```

With:
```typescript
try {
  await writeFile(filePath, result.patchedLines.join('\n'), 'utf-8');
```

**Optional**: If the `patchedLines` approach feels too invasive to the core `applyPatch` API, an alternative is to keep the current re-application code but add a comment explaining why it exists. Simplicity wins — I recommend the `patchedLines` approach since it's cleaner and avoids duplicating the apply logic.

---

### Step 5: Add round-trip integration tests

**Why**: The existing 28 tests only exercise `applyPatch` in isolation. They don't test the full tool execution path (schema parsing → `applyPatch` → JSON response → TUI rendering). Bug #1 and #2 could have been caught with integration tests.

**File**: `drone-agent/test/file.test.ts`

**Add tests**:

Test 1: Full tool execution with `file__apply_diff`:
```typescript
it('file__apply_diff produces correct JSON response with plain-text diff', async () => {
  const { registration, tools } = captureRegistration();
  await filePlugin.register(registration);
  const applyDiff = tools.get('apply_diff');
  expect(applyDiff).toBeDefined();

  const target = path.join(tmpdir(), `drone-agent-diff-${Date.now()}.txt`);
  await writeFile(target, 'line1\nline2\nline3\n', 'utf-8');
  try {
    const result = JSON.parse(await applyDiff!({
      path: target,
      hunks: [{
        anchors: ['line2'],
        contextBefore: ['line1'],
        oldLines: ['line2'],
        newLines: ['line2_modified'],
        contextAfter: ['line3'],
      }],
    }));
    expect(result.path).toBe(target);
    expect(result.patched).toBe(true);
    expect(result.summary).toBeDefined();
    expect(result.diff).toBeDefined();
    // Verify diff is plain text (no ANSI codes)
    expect(result.diff).not.toContain('\x1b[');
    // Verify the file was actually written
    const content = await readFile(target, 'utf-8');
    expect(content).toContain('line2_modified');
  } finally {
    await import('node:fs/promises').then(fs => fs.unlink(target).catch(() => {}));
  }
});
```

Test 2: TUI `formatDiffResult` with `patched` field:
```typescript
it('formatDiffResult recognizes patched field from apply_diff', async () => {
  // This tests the TUI function directly
  const { formatDiffResult } = await import('../src/tui/app.tsx');
  const result = formatDiffResult(JSON.stringify({
    path: '/tmp/test.txt',
    patched: true,
    summary: { hunks: 1, additions: 1, deletions: 1 },
    diff: '@@ -1 +1 @@\n-old\n+new',
  }));
  expect(result).toContain('Applied diff to');
  expect(result).toContain('/tmp/test.txt');
});
```

Note: If `formatDiffResult` is not exported from `app.tsx`, it may need to be exported for testing, or the test can be done through a different mechanism.

---

### Step 6: Run validation

1. Run `pnpm test` — all 827+ tests must pass
2. Run `pnpm typecheck` or check LSP diagnostics — no new errors
3. Verify the fix manually in TUI mode:
   - Use `file__apply_diff` on a simple file
   - Confirm the TUI shows "✓ Applied diff to ..."
   - Confirm the diff display shows `+`/`-`/`@@` prefixes with proper colors
4. Verify the LLM receives plain-text diff (no ANSI codes) in the tool result