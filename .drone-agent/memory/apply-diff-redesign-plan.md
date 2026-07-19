---
key: apply-diff-redesign-plan
tags:
  - plan
  - file-apply-diff
  - diff
  - patch
  - matching
  - completed
created: 2026-07-19T19:08:16.920Z
updated: 2026-07-19T19:35:18.012Z
---

# file__apply_diff Redesign — Implementation Plan

## Summary

Redesign the `file__apply_diff` tool's matching cascade to improve LLM success rates. The current engine requires `contextBefore + oldLines + contextAfter` to match as one contiguous block, drops interleaved context lines, and uses only the section heading as an anchor with rigid edit-position probing. The new design matches on the old change zone first, then narrows progressively via context, then via section heading — with aggressive format-aware fuzz (including line-break reflow) added at each level.

## Status: COMPLETED (2026-07-19)

### Work completed
All 9 implementation steps executed successfully. Commit `afed0dd` on branch `feature/apply-diff-redesign`.

**Files modified/created:**
- `drone-agent/src/shared/unified-diff-parser.ts` — parser now keeps interleaved context lines; adds typed `changeZone` field.
- `drone-agent/src/shared/patch-applier.ts` — rewritten as thin entry point (~270 lines) re-exporting types and containing the main `applyPatch` loop.
- `drone-agent/src/shared/patch-applier/types.ts` (NEW) — shared types (PatchHunk, MatchSpan, PatchError, PatchResult, AppliedHunk with hunkIndex, MatchSite, FuzzySuggestion, FailureType, NarrowResult).
- `drone-agent/src/shared/patch-applier/fuzz.ts` (NEW) — fuzz-level normalization (0/1/100/200), collapseWhitespace (newline-aware with lineMap back-reference), linesMatch.
- `drone-agent/src/shared/patch-applier/matching.ts` (NEW) — step 1 (exact oldLines), step 1.5 (aggressive collapse+substring), step 2 (context narrowing with 6-level loosening), step 3 (section-heading narrowing with 4-level loosening), lineHint tie-breaking, pure-insertion locator.
- `drone-agent/src/shared/patch-applier/levenshtein.ts` (NEW) — Levenshtein edit distance + findFuzzySuggestions (top 5, cap-at-5 for ties).
- `drone-agent/src/shared/patch-applier/errors.ts` (NEW) — Type 1/2/3 failure builders + reworked-hunk cheat sheet builder.
- `drone-agent/src/shared/diff-renderer.ts` — FuzzLevel extended to `0 | 1 | 100 | 200`; DiffHunkV2 gained optional `changeZone`; renderHunkV2 now renders interleaved context as ` ` (context) instead of spurious `-`/`+`; countChanges excludes interleaved context from additions/deletions.
- `drone-agent/src/plugins/file.ts` — formatPatchError rewritten for Type 1/2/3; apply_diff execute now writes on partial success (if ≥1 hunk applied); tool description updated; version bumped to 0.4.0.
- `drone-agent/test/unified-diff-parser.test.ts` — updated interleaved-context test to expect preservation; added changeZone assertion.
- `drone-agent/test/file.test.ts` — comprehensive rewrite: makeHunk helper, updated error assertions for new failure types, new tests for step 1.5 aggressive fuzz (line-break reflow/join), Type 1/2/3 failures, partial success, top-to-bottom application, lineHint tie-breaking, interleaved context regression, round-trip integration tests.

**Split rationale:** `patch-applier.ts` exceeded 1000 lines (AGENTS.md rule). Split into a `patch-applier/` directory with 5 helper modules; the main file is now ~270 lines.

### Validation results
- ✅ LSP diagnostics: clean (no errors, no warnings) on all modified/new files
- ✅ `pnpm lint` (ESLint + Prettier): passes
- ✅ `pnpm -r run build`: passes (all 7 packages compile)
- ✅ `pnpm run test` (fast suite): 1470 tests pass across 98 test files
- ✅ No dead code, no unused variables (removed unreachable return in fuzz.ts, unused PatchHunk import in matching.ts)
- ✅ No fluff comments

### Notes / decisions made during implementation
- The patch tool itself (file__apply_diff) repeatedly failed to apply patches during this implementation (ironic) — the OLD behavior's contiguous-block matching and interleaved-context dropping made patches against the very files being rewritten fail. This is itself evidence the redesign was needed. Used `file__write` (full rewrites) and Python scripts for surgical edits instead.
- Aggressive fuzz (step 1.5) collapses whitespace but NOT punctuation. Test data for line-break reflow tests had to account for trailing commas — `foo(a,b,c,)` ≠ `foo(a,b,c)`. This is by design (collapse whitespace only), but worth noting for LLM-generated patches that differ in punctuation.
- `AppliedHunk` gained a `hunkIndex` field so the tool wrapper can correlate applied hunks back to their original positions for diff rendering. This was discovered during implementation (the original plan didn't anticipate the correlation problem).
- TypeScript `switch` exhaustiveness: `case AGGRESSIVE_FUZZ:` with a `const` typed as `FuzzLevel` required `as const satisfies FuzzLevel` for the literal narrowing, plus the switch falls through to `case 100:`. The trailing unreachable `return` was removed after TS confirmed exhaustiveness.

## Original plan (preserved for reference)

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

### Step 1 — Refactor parser to keep interleaved context lines ✅
### Step 2 — Rewrite the matching engine core ✅
### Step 3 — Update PatchError / PatchResult types ✅
### Step 4 — Rewrite error formatting for the new failure types ✅
### Step 5 — Update the tool description ✅
### Step 6 — Update diff rendering compatibility ✅
### Step 7 — Tests ✅
### Step 8 — Validation ✅
### Step 9 — Commit and update memory ✅

## Validation criteria

- All LSP diagnostics pass (no errors, no warnings) for modified files. ✅
- `pnpm -r run lint` passes (ESLint + Prettier). ✅
- `pnpm -r run build` passes (TypeScript compilation across all packages). ✅
- `pnpm -r run test` passes (fast test suite) — including all new and updated unit tests. ✅ (1470 tests)
- No dead code, no unused variables, no fluff comments. ✅
- Files over 750 lines should be considered for splitting; over 1000 lines must be split. ✅ (patch-applier.ts split into patch-applier/ directory)
- Duplicated code must be extracted. ✅ (collapseWhitespace/normalizeLine shared via fuzz.ts)
- The final step of implementation MUST be to check the work against this plan's validation criteria. ✅