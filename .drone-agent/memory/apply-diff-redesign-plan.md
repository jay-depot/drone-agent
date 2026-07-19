---
key: apply-diff-redesign-plan
tags:
  - plan
  - file-apply-diff
  - diff
  - patch
  - matching
created: 2026-07-19T19:08:16.920Z
updated: 2026-07-19T19:08:16.920Z
---

# file__apply_diff Redesign — Implementation Plan

## Summary

Redesign the `file__apply_diff` tool's matching cascade to improve LLM success rates. The current engine requires `contextBefore + oldLines + contextAfter` to match as one contiguous block, drops interleaved context lines, and uses only the section heading as an anchor with rigid edit-position probing. The new design matches on the old change zone first, then narrows progressively via context, then via section heading — with aggressive format-aware fuzz (including line-break reflow) added at each level.

## Files involved

- `drone-agent/src/shared/unified-diff-parser.ts` (180 lines) — parser
- `drone-agent/src/shared/patch-applier.ts` (629 lines) — matching engine (largest rewrite)
- `drone-agent/src/plugins/file.ts` (448 lines) — tool wrapper + error formatting
- `drone-agent/src/shared/diff-renderer.ts` — rendering (check compatibility)
- Tests: locate existing test files in `drone-agent/test/`

## Top-level flow

- Process hunks **top-to-bottom** against the working copy (re-search from scratch for each hunk; no line-offset tracking).
- **Partial success** is allowed — successful hunks are applied to the file and written; failed hunks are reported in the error. No rollback. Goal: discourage falling back to sed/python.
- The existing 3-level fuzz (exact / trim-trailing / strip-all) is repurposed as the loosening cascade in steps 2 and 3, with a new aggressive level (collapse all whitespace including newlines) added on top.

## Parser changes (unified-diff-parser.ts)

- Interleaved context lines (` `-prefixed) inside the change zone are **kept**, not dropped.
- `oldLines` = old version of the change zone = `-` lines + interleaved ` ` lines in original positions.
- `newLines` = new version of the change zone = `+` lines + interleaved ` ` lines in original positions.
- `sectionHeading` remains the sole anchor source. `lineHint` retained as a tie-breaker.

## Per-hunk cascade

### Step 1 — Exact oldLines match
- Search whole file for the old change zone (oldLines) as a contiguous run.
- Exactly 1 match → apply.
- 0 matches → go to step 1.5.
- >1 matches → go to step 2 (context narrowing) with all survivors.

### Step 1.5 — Aggressive format-aware fuzz on oldLines
- Normalize both sides by collapsing ALL whitespace including newlines into a single string.
- Substring-search the normalized oldLines block in the normalized file.
- Handles: internal whitespace changes (spaces around operators, after commas, inside braces), indentation changes, and line-break reflow (wrap/join from prettier/eslint --fix).
- Variable-length spans on both sides: 1-line oldLines can match a multi-line file span, or multi-line oldLines can match a 1-line file span.
- The matched span [i..j] in file lines is what gets replaced by newLines.
- 1 match → apply (with span replacement).
- 0 matches → Type 2 failure path (fuzzy match `-` lines, suggest closest candidates).
- >1 matches → go to step 2 (context narrowing) with all survivors.

### Step 2 — Context narrowing (among survivors from step 1/1.5)
- Filter by surrounding context lines (contextBefore + contextAfter).
- Adjacency is immediate-before/immediate-after in the *same normalization* used to find the match. (For exact matches from step 1, adjacency is line-exact. For step-1.5 matches, adjacency is on the collapsed form.)
- Fuzzy adjacency (tolerating interleaved lines) is a known future extension but **out of scope for this round**.
- Loosening cascade (in order):
  1. Exact context match
  2. Trim-trailing-whitespace fuzz on context
  3. Strip-all-whitespace fuzz on context
  4. Aggressive format-aware fuzz on context (same normalization as step 1.5)
  5. Drop outer context lines progressively (try fewer and fewer)
  6. Require fewer context sides (only contextBefore, or only contextAfter)
- `lineHint` used as tie-breaker among otherwise-equivalent matches.
- Narrows to 1 → apply.
- Narrows to 0 at a given loosening level → try next loosening level. If still 0 after all levels → fall through to step 3 with the survivors from the *previous* level (the one that still had multiples). If no previous level had multiples either (shouldn't happen by construction, but defensively) → Type 3 failure.
- Still >1 after all loosening → go to step 3 (anchor narrowing) with all survivors.

### Step 3 — Section-heading narrowing (among survivors from step 2)
- Only runs if `sectionHeading` is present. Skipped entirely otherwise (step 2 survivors fall straight to Type 1 failure).
- Filter by section heading against each survivor's surrounding file lines.
- Loosening cascade (in order):
  1. Exact whole-line match
  2. Trim-trailing-whitespace whole-line match
  3. Strip-all-whitespace whole-line match
  4. Aggressive format-aware fuzz = **substring match on collapsed form** (collapse all ws including internal spaces; heading must appear as a substring of the collapsed file line). This catches abbreviated headings like `function foo(` matching `export async function foo(arg1, arg2) {`.
- Narrows to 1 → apply.
- Narrows to 0 at a given level → try next level. If 0 after all levels → Type 3 failure (unroll to last step that had multiples, report like Type 1).
- Still >1 after all loosening → Type 1 failure (report all matches with cheat sheet).
- More Type 1 failures are acceptable here by design — the new error reporting gives the LLM a cheat sheet to fix them.

## Failure reporting

### Type 1 (multiple survive all narrowing)
- Show each match with a couple of surrounding lines (3-5) and line numbers, so LLM can feed offsets back into file__read if it needs more.
- Emit a reworked hunk per match that adds minimal extra context lines from the file around that match site to make it uniquely target that occurrence. Goal: LLM can crib/resubmit verbatim.

### Type 2 (0 matches at step 1.5 — old code not in file in any form)
- Algorithm: Levenshtein edit distance on collapsed forms. Compare collapsed oldLines against each window of file lines (collapsed). Source files cap n*m fine in practice.
- Sort candidates by distance. Show top 5 closest spans, each with location + actual file content there, so LLM sees "you meant this, it's actually that".
- **Cap at 5:** if Levenshtein returns >5 equally-close candidates, treat it as a plain Type 2 failure (no suggestions) — the oldLines are too generic to be useful ("matched everything" instead of "matched nothing"), and listing a pile of near-misses would just be noise.

### Type 3 (later step over-narrowed to 0, earlier step had multiples)
- Unroll to the last step that had multiple matches, report like Type 1.

## Implementation steps

### Step 1 — Refactor parser to keep interleaved context lines
File: `drone-agent/src/shared/unified-diff-parser.ts`
- Modify `classifyBody` so that ` `-prefixed lines between `firstChangeIdx` and `lastChangeIdx` are no longer dropped.
- Build `oldLines` by walking the change zone and emitting `-` lines and interleaved ` ` lines (with ` ` prefix stripped) in original order.
- Build `newLines` by walking the change zone and emitting `+` lines and interleaved ` ` lines (with ` ` prefix stripped) in original order.
- `contextBefore` = ` ` lines before `firstChangeIdx`; `contextAfter` = ` ` lines after `lastChangeIdx` (unchanged).
- Update the comment block that currently says "deliberately dropped" to explain the new behavior.
- Add/adjust unit tests for interleaved context preservation.

### Step 2 — Rewrite the matching engine core
File: `drone-agent/src/shared/patch-applier.ts`
This is the largest change. Replace the existing `applyPatch` cascade with the new 3-step (plus 1.5) cascade. Likely split into helpers:

- `findExactOldLinesMatches(lines, oldLines): MatchSpan[]` — step 1.
- `findAggressiveOldLinesMatches(lines, oldLines): MatchSpan[]` — step 1.5. Collapse all ws including newlines on both sides; substring-search; map collapsed-match offsets back to file-line spans.
- `narrowByContext(lines, survivors, contextBefore, contextAfter, lineHint, level): MatchSpan[]` — step 2 single-level helper. Adjacency in the same normalization used to find the match.
- `narrowByContextCascade(lines, survivors, contextBefore, contextAfter, lineHint): MatchSpan[]` — runs the 6-level loosening cascade (exact → trim-trailing → strip-all → aggressive → drop outer context → require fewer sides).
- `narrowBySectionHeading(lines, survivors, sectionHeading): MatchSpan[]` — step 3 single-level helper.
- `narrowBySectionHeadingCascade(lines, survivors, sectionHeading): MatchSpan[]` — runs the 4-level loosening cascade.
- `applyHunk(workingLines, hunk, matchSpan): workingLines` — splice the matched span out and insert newLines.
- `buildType1Failure(hunk, survivors, lines): PatchError` — cheat sheet with surrounding lines + reworked hunk per match.
- `buildType2Failure(hunk, lines): PatchError` — Levenshtein on collapsed forms, top 5, cap at 5.
- `buildType3Failure(hunk, lastMultipleStep, survivors, lines): PatchError` — unroll to last multiple-match step, report like Type 1.
- `levenshtein(a, b): number` — collapsed-form edit distance helper (or import a tiny implementation).

Main loop: iterate hunks top-to-bottom, run the cascade against the current working copy, apply successful hunks as we go, collect errors for failed hunks.

### Step 3 — Update PatchError / PatchResult types
File: `drone-agent/src/shared/patch-applier.ts`
- `PatchError` needs new fields to carry the cheat sheet / suggestions: e.g., `matches?: { line: number; context: string[] }[]`, `reworkedHunks?: string[]`, `suggestions?: { line: number; content: string; distance: number }[]`, `failureType: 'type1' | 'type2' | 'type3'`.
- `PatchResult` already supports partial success (appliedHunks + errors + patchedLines) — confirm semantics and adjust if needed.

### Step 4 — Rewrite error formatting for the new failure types
File: `drone-agent/src/plugins/file.ts`
- Replace `formatPatchError` with a function that handles the three new failure types:
  - Type 1: list each match with line numbers + surrounding context, then each reworked hunk in a fenced code block.
  - Type 2: list up to 5 suggestions with location + actual file content, or a plain "not found" message if >5 equally-close candidates.
  - Type 3: same as Type 1 (unrolled to the last multiple-match step).
- Update the top-level error message to reflect partial success: "N of M hunk(s) failed. File was written with the successful hunks applied. Failed hunks:" vs the current "No changes were written."
- The tool wrapper's `execute` must write the file even when `result.success` is false (partial success), as long as at least one hunk succeeded. If zero hunks succeeded, do not write (nothing changed).

### Step 5 — Update the tool description
File: `drone-agent/src/plugins/file.ts`
- Update the `apply_diff` tool description to reflect the new behavior: partial success, top-to-bottom application, content-anchored matching with progressive loosening, aggressive format-aware fuzz.
- Update the patch inputSchema description similarly.

### Step 6 — Update diff rendering compatibility
File: `drone-agent/src/shared/diff-renderer.ts`
- Check that `renderDiffV2` still works with the new hunk structure (interleaved context in oldLines/newLines).
- The `DiffHunkV2` construction in `file.ts` maps `hunk.oldLines` and `hunk.newLines` directly — verify the renderer handles interleaved context correctly (it should, since it just renders +/- lines, but verify).

### Step 7 — Tests
- Locate existing tests for the patch applier and parser in `drone-agent/test/`.
- Add unit tests for each new behavior:
  - Parser keeps interleaved context (oldLines and newLines include interleaved ` ` lines).
  - Step 1 exact oldLines match: single match applies, multiple matches fall through.
  - Step 1.5 aggressive fuzz: line-break reflow (1-line oldLines ↔ multi-line file span and vice versa), internal ws changes.
  - Step 2 context narrowing: each loosening level (exact, trim, strip, aggressive, drop outer, fewer sides).
  - Step 3 heading narrowing: each loosening level, substring match on collapsed form for abbreviated headings.
  - Type 1 failure: cheat sheet with surrounding lines + reworked hunk.
  - Type 2 failure: Levenshtein suggestions (top 5), cap-at-5 behavior.
  - Type 3 failure: unroll to last multiple-match step.
  - Partial success: file written with successful hunks, failed hunks in error, no rollback.
  - Top-to-bottom application: later hunks see earlier hunks' changes.
  - lineHint as tie-breaker in steps 2/3.
- Add a regression test reproducing the old "interleaved context dropped" bug to confirm it's fixed.

## Validation criteria

- All LSP diagnostics pass (no errors, no warnings) for modified files.
- `pnpm -r run lint` passes (ESLint + Prettier). Note: re-read files after linting since prettier reformats.
- `pnpm -r run build` passes (TypeScript compilation across all packages).
- `pnpm -r run test` passes (fast test suite) — including all new and updated unit tests.
- No dead code, no unused variables, no fluff comments. Comments must be jsdoc or explain a complex algorithm/process, or be TODO/FIXME.
- Files over 750 lines should be considered for splitting; over 1000 lines must be split. `patch-applier.ts` is currently 629 lines and will grow significantly — likely needs splitting into helper modules (e.g., `patch-applier/` directory with `cascade.ts`, `fuzz.ts`, `levenshtein.ts`, `errors.ts`). Plan to split if it exceeds 750 lines after the rewrite.
- Duplicated code must be extracted (e.g., the normalization/collapse-whitespace logic shared by steps 1.5, 2, and 3 should live in one helper).
- The final step of implementation MUST be to check the work against this plan's validation criteria.