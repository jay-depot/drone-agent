/**
 * Patch applier — content-anchor-based patch matching and application.
 *
 * Implements a 4-step progressive cascade per hunk (processed top-to-bottom):
 *
 *   Step 1:   Exact match of the old change zone (oldLines) as a contiguous run.
 *   Step 1.5: Aggressive format-aware fuzz — collapse ALL whitespace including
 *             newlines on both sides and substring-search. Handles auto-formatter
 *             reflow (line wrap/join) and internal whitespace changes.
 *   Step 2:   Context narrowing — among multiple survivors, filter by the
 *             surrounding context lines (contextBefore + contextAfter) with a
 *             loosening cascade (exact → trim-trailing → strip-all → aggressive
 *             → drop outer context → require fewer context sides).
 *   Step 3:   Section-heading narrowing — among remaining survivors, filter by
 *             the @@ section heading with a loosening cascade (exact → trim →
 *             strip → aggressive substring on collapsed form).
 *
 * Hunks are applied top-to-bottom against a working copy; each hunk is matched
 * against the current state of the working copy (which reflects prior hunks).
 * Partial success is supported: successful hunks are applied and the file is
 * written; failed hunks are reported in the error and do not block others.
 *
 * Failure reporting:
 *   Type 1: Multiple matches survive all narrowing. Report every match with
 *           surrounding context and line numbers, plus a reworked hunk per
 *           match that would uniquely target it.
 *   Type 2: Zero matches at step 1.5 (old code not in file in any form).
 *           Levenshtein-fuzzy-match the oldLines against file windows and
 *           suggest the top 5 closest spans.
 *   Type 3: A later step over-narrowed to zero but an earlier step had
 *           multiples. Unroll to the last multiple-match step and report
 *           like Type 1.
 */

import type {
  AppliedHunk,
  MatchSpan,
  PatchError,
  PatchHunk,
  PatchResult,
} from './patch-applier/types.js';
import {
  buildType1Failure,
  buildType2Failure,
  buildType3Failure,
} from './patch-applier/errors.js';
import {
  findAggressiveOldLinesMatches,
  findExactOldLinesMatches,
  locatePureInsertion,
  narrowByContextCascade,
  narrowByHeadingCascade,
  sortByLineHint,
} from './patch-applier/matching.js';

// Re-export public types for consumers (file.ts, tests, parser).
export type {
  ChangeZoneLine,
  ChangeZoneLineKind,
} from './patch-applier/types.js';
export type { MatchSpan } from './patch-applier/types.js';
export type { AppliedHunk } from './patch-applier/types.js';
export type {
  MatchSite,
  FuzzySuggestion,
  FailureType,
} from './patch-applier/types.js';
export type {
  PatchHunk,
  PatchError,
  PatchResult,
} from './patch-applier/types.js';

/**
 * Splice the matched span out of the working lines and insert the new lines.
 * Mutates workingLines in place.
 */
function applySpan(
  workingLines: string[],
  span: MatchSpan,
  newLines: string[]
): void {
  workingLines.splice(span.start, span.end - span.start, ...newLines);
}

/**
 * Record a successfully-applied hunk. Centralizes the AppliedHunk construction
 * so every success path includes the original hunk index.
 */
function recordApplied(
  appliedHunks: AppliedHunk[],
  hunkIndex: number,
  anchors: string[],
  span: MatchSpan
): void {
  appliedHunks.push({
    anchors,
    fuzz: span.fuzz,
    appliedAtLine: span.start + 1,
    hunkIndex,
  });
}

/**
 * Apply a set of content-anchor-based hunks to a file's lines.
 *
 * Hunks are applied top-to-bottom. Each hunk is matched against the current
 * working copy (which reflects prior hunks). Partial success is supported:
 * successful hunks are applied; failed hunks are reported but do not block
 * others.
 *
 * @param lines - The file content as an array of lines (no trailing newline)
 * @param hunks - The hunks to apply
 * @returns PatchResult with applied hunks, errors, and patchedLines
 */
export function applyPatch(lines: string[], hunks: PatchHunk[]): PatchResult {
  const appliedHunks: AppliedHunk[] = [];
  const errors: PatchError[] = [];
  const workingLines = [...lines];

  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi];
    const {
      anchors,
      contextBefore,
      oldLines,
      newLines,
      contextAfter,
      lineHint,
      sectionHeading,
    } = hunk;

    // Special case: empty oldLines (pure insertion) — use context to locate.
    if (oldLines.length === 0) {
      const inserted = locatePureInsertion(
        workingLines,
        contextBefore,
        contextAfter,
        lineHint
      );
      if (inserted === null) {
        errors.push(buildType2Failure(hi, hunk, workingLines));
        continue;
      }
      workingLines.splice(inserted, 0, ...newLines);
      appliedHunks.push({
        anchors,
        fuzz: 0,
        appliedAtLine: inserted + 1,
        hunkIndex: hi,
      });
      continue;
    }

    // ── Step 1: exact oldLines match ────────────────────────────────
    let survivors = findExactOldLinesMatches(workingLines, oldLines);

    // ── Step 1.5: aggressive format-aware fuzz on oldLines ──────────
    if (survivors.length === 0) {
      survivors = findAggressiveOldLinesMatches(workingLines, oldLines);
      if (survivors.length === 0) {
        errors.push(buildType2Failure(hi, hunk, workingLines));
        continue;
      }
    }

    if (survivors.length === 1) {
      applySpan(workingLines, survivors[0], newLines);
      recordApplied(appliedHunks, hi, anchors, survivors[0]);
      continue;
    }

    // ── Step 2: context narrowing ───────────────────────────────────
    const ctxResult = narrowByContextCascade(
      workingLines,
      survivors,
      contextBefore,
      contextAfter
    );
    survivors = ctxResult.survivors;

    if (survivors.length === 1) {
      applySpan(workingLines, survivors[0], newLines);
      recordApplied(appliedHunks, hi, anchors, survivors[0]);
      continue;
    }

    if (survivors.length === 0) {
      errors.push(
        buildType3Failure(hi, ctxResult.lastMultiple, workingLines, hunk)
      );
      continue;
    }

    // ── Step 3: section-heading narrowing ───────────────────────────
    if (sectionHeading) {
      const headingResult = narrowByHeadingCascade(
        workingLines,
        survivors,
        sectionHeading
      );
      survivors = headingResult.survivors;

      if (survivors.length === 1) {
        applySpan(workingLines, survivors[0], newLines);
        recordApplied(appliedHunks, hi, anchors, survivors[0]);
        continue;
      }

      if (survivors.length === 0) {
        errors.push(
          buildType3Failure(hi, headingResult.lastMultiple, workingLines, hunk)
        );
        continue;
      }
    }

    // ── lineHint tie-break ──────────────────────────────────────────
    if (lineHint !== undefined) {
      const sorted = sortByLineHint(survivors, lineHint);
      const closest = sorted[0];
      const closestDist = Math.abs(closest.start - (lineHint - 1));
      const tiedAtClosest = sorted.filter(
        s => Math.abs(s.start - (lineHint - 1)) === closestDist
      );
      if (tiedAtClosest.length === 1) {
        applySpan(workingLines, closest, newLines);
        recordApplied(appliedHunks, hi, anchors, closest);
        continue;
      }
      survivors = tiedAtClosest;
    }

    // ── Type 1: multiple matches survive all narrowing ──────────────
    errors.push(buildType1Failure(hi, survivors, workingLines, hunk));
  }

  return {
    success: errors.length === 0,
    appliedHunks,
    errors,
    patchedLines: workingLines,
  };
}
