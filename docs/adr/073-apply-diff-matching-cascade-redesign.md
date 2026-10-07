---
tags: [decision, file-plugin, diff-format, matching-engine]
related: [drone-agent-plugins.md, 033-file-apply-diff-v2.md, 038-file-apply-diff-unified-diff.md, 048-large-file-splitting.md]
---

# 073: `file__apply_diff` Matching Cascade Redesign

**Status**: Implemented (2026-07-19)

**Supersedes**: [038-file-apply-diff-unified-diff](038-file-apply-diff-unified-diff.md) (matching engine only — the unified diff *input format* is preserved)

## Context

ADR 038 replaced the nested JSON hunk format with a flat unified diff *string* input (a success — LLMs produce valid unified diff strings reliably). But the *matching engine* under that format had three pain points that caused patches to fail even when the LLM's intent was correct:

1. **Contiguous-block matching was rigid.** The engine required `contextBefore + oldLines + contextAfter` to match as one contiguous run at a candidate site. A single mismatched line (even from a small formatting change elsewhere) failed the whole hunk.

2. **Interleaved context lines inside the change zone were silently dropped.** The parser classified body lines by prefix and assigned ` `-prefixed lines between the first and last `-`/`+` line to *neither* `oldLines` nor `newLines`. This was surprising behavior — standard unified-diff semantics say those lines belong to both the old and new versions of the change zone. The information loss caused matches to fail when the LLM correctly wrote interleaved context.

3. **Only the section heading was used as an anchor, with rigid edit-position probing.** `tryMatchContext` tried only two edit positions (at the anchor, or anchor+1). Section headings were matched as whole lines (no substring matching), so an abbreviated heading like `function foo(` wouldn't match `export async function foo(arg1, arg2) {`.

In practice, the old tool's own author couldn't use `file__apply_diff` to patch the very files implementing the redesign — the contiguous-block matching and interleaved-context dropping made patches fail repeatedly. This was itself the strongest evidence the redesign was needed.

## Decision

Rewrite the matching engine as a **4-step progressive cascade** per hunk, processed **top-to-bottom** with **partial success**. Preserve the unified diff *input format* from ADR 038 — only the matching behavior changes.

### Top-level flow

- Hunks are applied **top-to-bottom** (not bottom-up) against a working copy. Each hunk is matched against the current state of the working copy (which reflects prior hunks). No line-offset tracking — re-search from scratch for each hunk (overengineering to track deltas given content-anchored search re-runs anyway).
- **Partial success** is supported: successful hunks are applied and the file is written; failed hunks are reported in the error but do not block others. Goal: discourage falling back to sed/python.
- The existing 3-level fuzz (exact / trim-trailing / strip-all) is repurposed as the loosening cascade in steps 2 and 3, with a new **aggressive level** (collapse all whitespace including newlines) added on top.

### Parser changes (preserving interleaved context)

Interleaved ` `-prefixed lines inside the change zone are **kept** (standard unified-diff semantics):

- `oldLines` = old version of the change zone = `-` lines + interleaved ` ` lines in original positions.
- `newLines` = new version of the change zone = `+` lines + interleaved ` ` lines in original positions.
- A typed `changeZone: ChangeZoneLine[]` field preserves the diff structure so the renderer can show interleaved context as ` ` (context) rather than as spurious `-`/`+` changes.
- `sectionHeading` remains the sole anchor source. `lineHint` retained as a tie-breaker.

### Step 1 — Exact oldLines match

Search the whole file for the old change zone (oldLines) as a contiguous run.

- Exactly 1 match → apply.
- 0 matches → go to step 1.5.
- >1 matches → go to step 2 (context narrowing) with all survivors.

### Step 1.5 — Aggressive format-aware fuzz on oldLines

Collapse ALL whitespace (including newlines) on both sides into a single string and **substring-search** the collapsed oldLines block in the collapsed file.

- Handles: internal whitespace changes (spaces around operators, after commas, inside braces), indentation changes, and **line-break reflow** (wrap/join from prettier/eslint --fix).
- **Variable-length spans in both directions:** a 1-line oldLines block can match a multi-line file span (formatter wrapped it), and a multi-line oldLines block can match a 1-line file span (formatter joined lines). The matched span `[start..end)` in file lines is what gets replaced by newLines.
- 1 match → apply (with span replacement). 0 matches → Type 2 failure. >1 matches → step 2 with survivors.

### Step 2 — Context narrowing (6-level loosening cascade)

Among the multiple match sites, filter by `contextBefore` + `contextAfter`. Adjacency is immediate-before/after in the *same normalization* used to find the match (line-exact for step 1 matches; collapsed-form for step 1.5 matches). Fuzzy adjacency (tolerating interleaved lines) is a known future extension but out of scope for this round.

Loosening cascade (in order):

1. Exact context match
2. Trim-trailing-whitespace fuzz on context
3. Strip-all-whitespace fuzz on context
4. Aggressive format-aware fuzz on context (same normalization as step 1.5)
5. Drop outer context lines progressively (try fewer and fewer)
6. Require fewer context sides (only `contextBefore`, or only `contextAfter`)

`lineHint` is used as a tie-breaker among otherwise-equivalent matches. Narrows to 1 → apply. Narrows to 0 at a given level → try the next level; if 0 after all levels → fall through to step 3 with the survivors from the *previous* (multiple-match) level. Still >1 → step 3.

### Step 3 — Section-heading narrowing (4-level loosening cascade)

Only runs if `sectionHeading` is present; skipped entirely otherwise (step 2 survivors fall straight to Type 1 failure). The heading must match some file line within a small window before the match span.

Loosening cascade:

1. Exact whole-line match
2. Trim-trailing-whitespace whole-line match
3. Strip-all-whitespace whole-line match
4. **Aggressive format-aware fuzz = substring match on collapsed form** (collapse all whitespace including internal spaces; heading must appear as a substring of the collapsed file line). This catches abbreviated headings like `function foo(` matching `export async function foo(arg1, arg2) {`.

Narrows to 1 → apply. Narrows to 0 after all levels → Type 3 failure (unroll). Still >1 → Type 1 failure.

**More Type 1 failures are acceptable here by design** — the new error reporting gives the LLM a cheat sheet to fix them.

## Failure Reporting

### Type 1 (multiple matches survive all narrowing)

Show each match with a few surrounding lines (3-5) and line numbers, so the LLM can feed offsets back into `file__read` if it needs more. Emit a **reworked hunk per match** that adds minimal extra context lines from the file around that match site to make it uniquely target that occurrence. Goal: the LLM can crib and resubmit verbatim.

### Type 2 (old code not found at step 1.5)

Levenshtein edit distance on collapsed forms. Compare the collapsed oldLines against each window of file lines (collapsed). Sort candidates by distance. Show the **top 5 closest spans**, each with location + actual file content there, so the LLM sees "you meant this, it's actually that."

**Cap at 5:** if Levenshtein returns more than 5 equally-close candidates, treat it as a plain Type 2 failure (no suggestions) — the oldLines are too generic to be useful ("matched everything" instead of "matched nothing"), and listing a pile of near-misses would just be noise.

### Type 3 (later step over-narrowed to zero, earlier step had multiples)

Unroll to the last step that had multiple matches and report like Type 1.

## File split

`patch-applier.ts` grew beyond 1,000 lines during the rewrite (AGENTS.md rule: must split at 1,000). Split into a `patch-applier/` directory with 5 helper modules; the main file is now ~270 lines.

| Module | Responsibility |
|--------|----------------|
| `patch-applier/types.ts` | Shared types: `PatchHunk`, `MatchSpan`, `PatchError`, `PatchResult`, `AppliedHunk` (with `hunkIndex`), `MatchSite`, `FuzzySuggestion`, `FailureType`, `NarrowResult` |
| `patch-applier/fuzz.ts` | Fuzz-level normalization (`0`/`1`/`100`/`200`), `collapseWhitespace` (newline-aware with `lineMap` back-reference), `linesMatch` |
| `patch-applier/matching.ts` | Step 1 (exact), step 1.5 (aggressive collapse+substring), step 2 (context narrowing with 6-level loosening), step 3 (heading narrowing with 4-level loosening), `lineHint` tie-breaking, pure-insertion locator |
| `patch-applier/levenshtein.ts` | Levenshtein edit distance + `findFuzzySuggestions` (top 5, cap-at-5 for ties) |
| `patch-applier/errors.ts` | Type 1/2/3 failure builders + reworked-hunk cheat sheet builder |

See [048-large-file-splitting](048-large-file-splitting.md) for the broader refactoring pattern.

## Implementation Notes

- The patch tool itself (the OLD `file__apply_diff`) repeatedly failed to apply patches during this very rewrite — the contiguous-block matching and interleaved-context dropping made patches against the implementing files fail. Used `file__write` (full rewrites) and Python scripts for surgical edits instead. This is itself evidence the redesign was needed.
- Aggressive fuzz (step 1.5) collapses whitespace but **not punctuation**. `foo(a,b,c,)` (prettier-style trailing comma) collapses to a different string than `foo(a,b,c)` (no trailing comma). This is by design (whitespace-only normalization), but worth noting for LLM-generated patches that differ in punctuation.
- `AppliedHunk` gained a `hunkIndex` field (not in the original plan) so the tool wrapper can correlate applied hunks back to their original positions for diff rendering. When designing a partial-success API, always include the original index on each success record so callers can correlate.
- TypeScript `switch` exhaustiveness: `case AGGRESSIVE_FUZZ:` with a `const` typed as `FuzzLevel` required `as const satisfies FuzzLevel` for the literal narrowing, and the switch falls through to `case 100:`.

## Consequences

- **Positive**: Patches with interleaved context lines now work (standard unified-diff semantics restored).
- **Positive**: Auto-formatter reflow (prettier/eslint --fix line wrap/join) is handled by aggressive fuzz at step 1.5.
- **Positive**: Abbreviated section headings now match via substring-on-collapsed-form at step 3.
- **Positive**: Partial success — successful hunks are applied and written; the LLM doesn't have to fall back to sed/python.
- **Positive**: Type 1 failures give the LLM a cheat sheet it can crib and resubmit, so more ambiguous-match failures are acceptable.
- **Positive**: Type 2 failures suggest the closest file spans, so the LLM can self-correct when the old code isn't in the file.
- **Positive**: The patch tool now works against its own source files (the redesign dogfoods itself).
- **Negative**: Aggressive fuzz does not normalize punctuation — LLM patches that differ in trailing commas or semicolons will not match even at the aggressive level. A future extension could add punctuation normalization.
- **Negative**: The matching engine is more complex (4 steps, multiple loosening cascades, Levenshtein) — but it's split across focused modules.

## Validation

- ✅ LSP diagnostics: clean (no errors, no warnings) on all modified/new files
- ✅ `pnpm lint` (ESLint + Prettier): passes
- ✅ `pnpm -r run build`: passes (all 7 packages)
- ✅ `pnpm run test` (fast suite): 1470 tests pass across 98 test files
- ✅ No dead code, no unused variables, no fluff comments
- ✅ File-size rule satisfied (`patch-applier.ts` split into `patch-applier/` directory)

## Implementation Files

- `drone-agent/src/shared/unified-diff-parser.ts` — parser now keeps interleaved context; adds typed `changeZone` field
- `drone-agent/src/shared/patch-applier.ts` — rewritten as thin entry point (~270 lines)
- `drone-agent/src/shared/patch-applier/types.ts` — NEW shared types
- `drone-agent/src/shared/patch-applier/fuzz.ts` — NEW fuzz normalization
- `drone-agent/src/shared/patch-applier/matching.ts` — NEW matching cascade
- `drone-agent/src/shared/patch-applier/levenshtein.ts` — NEW Levenshtein + suggestions
- `drone-agent/src/shared/patch-applier/errors.ts` — NEW failure builders
- `drone-agent/src/shared/diff-renderer.ts` — `FuzzLevel` extended to `0 | 1 | 100 | 200`; `DiffHunkV2` gained optional `changeZone`; renderer shows interleaved context as ` ` not `-`/`+`
- `drone-agent/src/plugins/file.ts` — `formatPatchError` rewritten for Type 1/2/3; partial-success file writing; tool description updated; version 0.4.0
- `drone-agent/test/unified-diff-parser.test.ts` — updated interleaved-context test
- `drone-agent/test/file.test.ts` — comprehensive rewrite with new tests for all new behaviors

## Related

- [drone-agent-plugins](../../drone-agent/src/plugins/) — File plugin
- [033-file-apply-diff-v2](033-file-apply-diff-v2.md) — Original content-anchor format (superseded by 038)
- [038-file-apply-diff-unified-diff](038-file-apply-diff-unified-diff.md) — Unified diff input format (matching engine superseded by this ADR; input format preserved)
- [048-large-file-splitting](048-large-file-splitting.md) — Large file splitting pattern (this ADR split `patch-applier.ts` into a directory)