---
key: file-apply-diff-unified-diff-v3
tags:
  []
created: 2026-07-02T01:29:49.890Z
updated: 2026-07-02T01:36:14.165Z
---

# Plan: Replace nested JSON hunks with flat unified diff strings for `file__apply_diff`

## Summary

The `file__apply_diff` tool currently accepts a nested JSON structure — an array of hunk objects each with `anchors`, `contextBefore`, `oldLines`, `newLines`, `contextAfter` (each being an array of strings). The LLM struggles to reliably produce this nested array-of-objects-of-arrays structure. We'll change the `inputSchema` to accept a single `patch` string in standard unified diff format (like `git diff` output), which is far more natural for LLMs to generate. We'll add a unified diff parser that converts the patch string into the existing `PatchHunk` type, reusing the existing `applyPatch()` content-anchor matching engine, fuzzy matching, and error reporting infrastructure.

**Core insight**: This revisits ADR #033's decision that "JSON schema is better because we can constrain the output format at the API level." In practice, the freeform text format is still within a structured JSON tool call (`{ path, patch }`), and LLMs produce valid unified diff strings much more reliably than valid nested JSON arrays-of-objects.

## New Dependencies

- None. The implementation uses only built-in `regex` and standard library types. No npm package required for diff parsing.

## Files to Create

### `drone-agent/src/shared/unified-diff-parser.ts` (new)

Converts a unified diff string into `HunkWithHints[]` (extends `PatchHunk`).

```typescript
export interface HunkWithHints extends PatchHunk {
  lineHint?: number;           // 1-based start line from @@ -start,count ...
  sectionHeading?: string;     // Text after @@ ... @@
}

export function parseUnifiedDiff(diff: string): HunkWithHints[];
```

**Parsing algorithm (in detail):**

1. **Split into hunk segments** using regex: `/^@@[ ]+-(\d+)(?:,(\d+))?[ ]+\+(\d+)(?:,(\d+))?[ ]+@@(.*)$/gm` — this matches `@@ -start,count +start,count @@ rest` across all lines. Each match boundary defines a hunk segment.

2. **For each segment**, extract:
   - `lineHint` = the `-start` group (old-file start line number), 1-based
   - `sectionHeading` = the trailing text after `@@`, trimmed

3. **Classify body lines** within each segment:
   - Lines starting with ` ` → context
   - Lines starting with `-` → oldLines
   - Lines starting with `+` → newLines
   - Lines starting with `\` (no-newline marker) → skip silently

4. **Assign context to before/after**: All context lines before the first `-` or `+` → `contextBefore`. All context lines after the last `-` or `+` → `contextAfter`.

5. **Build anchors**: If `sectionHeading` is non-empty, push it into `anchors`. Otherwise leave `anchors` empty.

**Edge cases handled:**
- Hunk header without heading: `@@ -10,4 +10,4 @@` → anchors=[], lineHint=10
- Hunk header without count: `@@ -10 +12 @@` → implied count=1
- Pure insertion: `@@ -1,0 +1,3 @@` → oldLines=[], newLines=[...]
- Pure deletion: `@@ -3,3 +0,0 @@` → oldLines=[...], newLines=[]
- `\ No newline at end of file` → dropped
- Empty patch string → `[]`

### `drone-agent/test/unified-diff-parser.test.ts` (new)

**Tests:**
1. Basic single-hunk diff → correct fields
2. Multi-hunk (two `@@` sections, applied bottom-up) → both hunks
3. Section heading: `@@ -5,7 +5,7 @@ def foo():` → sectionHeading = "def foo():"
4. Line number extraction: `@@ -10,4 +12,3 @@` → lineHint = 10
5. No count in header: `@@ -10 +12 @@` → implied 1
6. Pure insertion: `@@ -1,0 +1,3 @@` → empty oldLines
7. Pure deletion: `@@ -3,3 +0,0 @@` → empty newLines
8. No-newline marker → silently dropped
9. Empty string → returns []
10. Context lines assigned correctly to contextBefore vs contextAfter

## Files to Modify

### `drone-agent/src/shared/patch-applier.ts`

**Add to `PatchHunk` interface:**
```typescript
export interface PatchHunk {
  anchors: string[];
  contextBefore: string[];
  oldLines: string[];
  newLines: string[];
  contextAfter: string[];
  lineHint?: number;           // NEW: 1-based line number hint
  sectionHeading?: string;     // NEW: section heading from @@ header
}
```

**Modify `applyPatch()` — hint-based search prioritization:**

In the **anchored strategy** (where `anchors.length > 0`):
- After finding anchor candidates via `findAnchorOccurrences`, if `lineHint` is provided, prefer the candidate nearest to `lineHint - 1` (0-based). Sort candidates by absolute distance to `lineHint` and try them in proximity order.

In the **context-only strategy** (no anchors):
- Before sliding across the full file, try a focused window around `lineHint`: range `[max(0, lineHint-1-15), min(lines.length, lineHint-1+oldLines.length+15)]`. If that returns a match, use it. Only if not, fall through to full-file search.
- If `sectionHeading` is set and anchors are empty, do a one-shot anchor search with `[sectionHeading]` before going to context-only — treat the heading as a free anchor.

**Key design rule:** These are hints, not requirements. If hint-based search fails, always fall through to the full context-based search. This preserves the robustness of the content-anchor system even when the LLM provides bad line numbers.

**Existing tests should still pass** — `PatchHunk` gets optional new fields, and `applyPatch()` only gets smarter.

### `drone-agent/src/plugins/file.ts`

**New `inputSchema`:**
```typescript
inputSchema: {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description: 'Absolute path to the file to modify.',
    },
    patch: {
      type: 'string',
      description:
        'Unified diff to apply. Format matching `git diff` output:\n\n' +
        '@@ -5,7 +5,7 @@ function_name():\n' +
        '     context\n' +
        '     context\n' +
        '-    removed line\n' +
        '+    added line\n' +
        '     context\n\n' +
        'Hunks start with @@ -start,count +start,count @@ [section].\n' +
        'Lines with ` ` are context, `-` are removed, `+` are added.\n' +
        'Multiple hunks (multiple @@ sections) are applied bottom-up.\n' +
        'Line numbers and section headings are hints — content-anchored\n' +
        'context matching is used for accuracy.\n\n' +
        'Tip: Use `git diff`, `git show`, or construct the diff manually.\n' +
        'For simple edits, include 2-3 lines of context around changes.\n' +
        'To see the current file content, use file__read first.',
    },
  },
  required: ['path', 'patch'],
  additionalProperties: false,
}
```

**New `execute` handler:**
```typescript
execute: async input => {
  if (typeof input.path !== 'string' || !input.path.trim())
    throw new Error('file__apply_diff requires a non-empty path string.');
  if (typeof input.patch !== 'string' || !input.patch.trim())
    throw new Error('file__apply_diff requires a non-empty patch string.');

  const filePath = path.resolve(input.path.trim());
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw enhanceFsError('file__apply_diff', filePath, err);
  }
  const lines = content.split('\n');

  // Parse unified diff to internal hunk format
  const hunks = parseUnifiedDiff(input.patch);
  if (hunks.length === 0) {
    throw new Error(
      'file__apply_diff: no hunks found in patch string.\n\n' +
      'The patch did not contain any @@ ... @@ hunk headers. ' +
      'Make sure the patch uses unified diff format, e.g.:\n' +
      '@@ -5,7 +5,7 @@ function_name():\n' +
      '     context\n' +
      '-    old line\n' +
      '+    new line'
    );
  }

  // Apply using existing content-anchor engine
  const result = applyPatch(lines, hunks);

  if (!result.success) {
    // Concise error messages in unified-diff language
    const errorMessages = result.errors
      .map(e => formatParseDiffError(e))
      .join('\n\n');
    throw new Error(
      `file__apply_diff: ${result.errors.length} of ${hunks.length} hunk(s) failed to apply.\n\n${errorMessages}\n\n` +
      `Tip: Re-read the file with file__read to confirm the current contents, then correct the patch and try again.`
    );
  }

  // Build DiffHunkV2 for rendering (HunkWithHints extends PatchHunk)
  const diffHunks = hunks.map((hunk, i) => ({
    anchors: hunk.anchors,
    contextBefore: hunk.contextBefore,
    oldLines: hunk.oldLines,
    newLines: hunk.newLines,
    contextAfter: hunk.contextAfter,
    fuzz: result.appliedHunks[i]?.fuzz,
  }));

  const diffResult = renderDiffV2(filePath, diffHunks, false);

  // Write patched content
  try {
    await writeFile(filePath, result.patchedLines.join('\n'), 'utf-8');
  } catch (err) {
    throw enhanceFsError('file__apply_diff', filePath, err);
  }

  return JSON.stringify(
    {
      path: filePath,
      patched: true,
      summary: diffResult.summary,
      diff: diffOutput,
    },
    null,
    2
  );
}
```

**Error translation helper (also in `file.ts` or a small utility):**
```typescript
function formatParseDiffError(e: PatchError): string {
  const hunkTag = `Hunk ${e.hunkIndex}:`;

  if (e.message.startsWith('Anchor not found')) {
    const heading = e.anchors[0] || '(no anchor)';
    return (
      `${hunkTag} The @@ section heading "${heading}" was not found in the file.\n` +
      `  Detail: The heading was not found at any fuzz level. ` +
      `Try removing the heading from the @@ line, or re-read the file to find the correct section.`
    );
  }

  if (e.message.startsWith('Anchor chain not found')) {
    return (
      `${hunkTag} The @@ section heading chain "${e.anchors.join(' > ')}" could not be matched.\n` +
      `  Detail: The first heading "${e.anchors[0]}" exists, but subsequent headings don't follow it.`
    );
  }

  if (e.message.includes('Context does not match')) {
    const expectedOld = e.foundOldLines?.length
      ? JSON.stringify(e.foundOldLines)
      : 'nothing';
    const receivedOld = e.foundOldLines
      ? JSON.stringify(e.anchors?.length ? e.foundOldLines : [])
      : '(unknown)';
    // Build a focused message: show what the patch expected vs what the file has
    const atLine = e.foundOldLines
      ? `near line ${e.hunkIndex + 1 /* approximate */}`
      : 'at the anchor location';
    return (
      `${hunkTag} The \`-\` lines didn't match what's in the file ${atLine}.\n` +
      `  Your patch shows: ${expectedOld}\n` +
      `  The file has:     ${receivedOld}\n` +
      `  Re-read the file with file__read to confirm, then fix the \`-\` lines.`
    );
  }

  if (e.message.includes('Context not found anywhere')) {
    return (
      `${hunkTag} The context lines around the change couldn't be matched anywhere in the file.\n` +
      `  The patch expects these context lines above the change: ${JSON.stringify(e.anchors?.[0] ? [] : [])}\n` +
      `  and these \`-\` lines: ${JSON.stringify(e.foundOldLines)}\n` +
      `  Re-read the file with file__read to see the current content, then adjust the context lines in the patch.`
    );
  }

  // Fallback
  return `${hunkTag} ${e.message}\n  Detail: ${e.detail}`;
}
```

**Removed imports:** `isRecord` from `'../shared/type-guards.js'` (was only used for hunks parsing).

**Imports to add:**
- `import { parseUnifiedDiff } from '../shared/unified-diff-parser.js';`
- `import type { PatchError } from '../shared/patch-applier.js';` (for the error formatter)

### `drone-agent/test/file.test.ts`

**Update the round-trip integration test:**
- Replace `applyDiff!({ path: target, hunks: [{...}] })` with `applyDiff!({ path: target, patch: '@@ ... @@\n ...' })`

**New round-trip tests:**
1. Multi-hunk patch (two `@@` sections applied bottom-up) — write three lines, change two, verify both
2. Pure insertion — `@@ -1,0 +1,3 @@` → lines inserted at top
3. Pure deletion — `@@ -3,3 +0,0 @@` → lines removed
4. Fuzzy match via unified diff — deliberately mismatched whitespace in context lines; expect fuzz > 0

**Keep all existing `applyPatch` unit tests** — these test the core matching engine directly and are format-agnostic.

### `drone-agent/src/shared/patch-applier.ts` — error message format note

The existing `PatchError` type doesn't need to change — it already has `message`, `detail`, `anchors`, `foundOldLines`, etc. The *formatting* of these errors into text for the LLM moves to `file.ts` (the `formatParseDiffError` helper above). This keeps `patch-applier.ts` as a pure algorithmic module and the user-facing message formatting in the plugin layer.

## Files Not Changed

- **`drone-agent/src/tui/app.tsx`** — The tool output format is unchanged (`{ path, patched, summary, diff }`). The `formatDiffResult` function already handles this correctly.
- **`drone-agent/src/shared/diff-renderer.ts`** — The output-side rendering takes `DiffHunkV2[]` arrays which are constructed after successful application. Input format change doesn't affect this.
- **`drone-agent/src/shared/type-guards.ts`** — Unused after this change. Could be cleaned up but not required.

## Step-by-Step Implementation Order

| Step | Files | Description | Dependencies |
|------|-------|-------------|--------------|
| **Step 1** | `src/shared/unified-diff-parser.ts` + `test/unified-diff-parser.test.ts` | Create the parser and its unit tests | None |
| **Step 2** | `src/shared/patch-applier.ts` | Add `lineHint`/`sectionHeading` fields to `PatchHunk`; add hint-based search prioritization to `applyPatch()` | None |
| **Step 3** | `src/plugins/file.ts` | Rewrite tool registration — new `{ path, patch }` schema, new description, new execute handler calling `parseUnifiedDiff` + `applyPatch`, error formatting in unified-diff language | Step 1, Step 2 |
| **Step 4** | `test/file.test.ts` | Update round-trip tests; add new tests for multi-hunk, insertion/deletion, fuzzy-match via patch string | Steps 1-3 |
| **Step 5** | All | Run `pnpm typecheck && pnpm lint && pnpm test`; fix any issues | Steps 1-4 |
| **Step 6** | All | Read through all changed files; verify correctness; run final test suite | Step 5 |

## Validation Criteria

1. ✅ `pnpm typecheck` passes with zero errors
2. ✅ `pnpm lint` passes with zero errors
3. ✅ `pnpm test` passes — all existing `applyPatch()` unit tests still pass; all new parser and integration tests pass
4. ✅ The new tool accepts `{ path: "...", patch: "..." }` and rejects `{ path: "...", hunks: [...] }` (missing required `patch`)
5. ✅ The tool output format is unchanged — `{ path, patched, summary, diff }` — so the TUI works without changes
6. ✅ The `color` parameter, `isRecord` import, and all old `hunks`-based parsing code are removed from `file.ts`
7. ✅ Unified diff parser correctly handles: single hunk, multi-hunk, pure insertion, pure deletion, section headings, no-newline markers, empty patch
8. ✅ Line hints from `@@ -start,...` headers are used for search prioritization but don't prevent successful matching if incorrect
9. ✅ Section headings from `@@ ... @@ heading` are used as soft anchor hints but don't prevent matching if absent or wrong
10. ✅ Error messages speak in unified-diff terms (`-` lines, context lines, `@@` headers) — not internal `anchors`/`contextBefore` terms
11. ✅ Every error message ends with or contains the "re-read the file" / "use file__read to confirm" nudge