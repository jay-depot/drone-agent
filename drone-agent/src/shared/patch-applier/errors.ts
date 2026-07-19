/**
 * Failure builders for the patch-applier cascade.
 *
 * Three failure types:
 *   Type 1: Multiple matches survive all narrowing → cheat sheet with each
 *           match site (line number + surrounding context) and a reworked
 *           hunk per match that would uniquely target it.
 *   Type 2: Zero matches at step 1.5 (old code not in file in any form) →
 *           Levenshtein-fuzzy-match the oldLines against file windows and
 *           suggest the top 5 closest spans.
 *   Type 3: A later step over-narrowed to zero but an earlier step had
 *           multiples → unroll to the last multiple-match step and report
 *           like Type 1.
 */

import type { MatchSite, MatchSpan, PatchError, PatchHunk } from './types.js';
import { findFuzzySuggestions } from './levenshtein.js';

/** Number of surrounding file lines to show in a cheat sheet match site. */
const CHEAT_SHEET_CONTEXT_LINES = 3;

/**
 * Build a reworked hunk (unified diff text) that would uniquely target a
 * given match site. Adds minimal extra context lines from the file around
 * the match span until the hunk would uniquely identify that site vs. the
 * other match sites.
 */
function buildReworkedHunk(
  fileLines: string[],
  match: MatchSpan,
  otherMatches: MatchSpan[],
  oldLines: string[],
  newLines: string[],
  contextBefore: string[],
  contextAfter: string[],
  sectionHeading?: string
): string {
  const maxGrow = Math.max(match.start, fileLines.length - match.end);
  let extraBefore = 0;
  let extraAfter = 0;

  const isUnique = (): boolean => {
    const beforeStart = match.start - contextBefore.length - extraBefore;
    const afterEnd = match.end + contextAfter.length + extraAfter;
    for (const other of otherMatches) {
      if (other.start === match.start && other.end === match.end) continue;
      const otherBeforeStart = other.start - contextBefore.length - extraBefore;
      const otherAfterEnd = other.end + contextAfter.length + extraAfter;
      if (beforeStart === otherBeforeStart && afterEnd === otherAfterEnd) {
        return false;
      }
    }
    return true;
  };

  while (!isUnique() && (extraBefore < maxGrow || extraAfter < maxGrow)) {
    if (extraBefore < maxGrow) extraBefore++;
    if (!isUnique() && extraAfter < maxGrow) extraAfter++;
  }

  const beforeStart = Math.max(
    0,
    match.start - contextBefore.length - extraBefore
  );
  const afterEnd = Math.min(
    fileLines.length,
    match.end + contextAfter.length + extraAfter
  );
  const beforeCtx = fileLines.slice(beforeStart, match.start);
  const afterCtx = fileLines.slice(match.end, afterEnd);

  const lines: string[] = [];
  const oldStartLine = beforeStart + 1;
  const newStartLine = oldStartLine;
  const oldCount = match.end - match.start + beforeCtx.length + afterCtx.length;
  const newCount = newLines.length + beforeCtx.length + afterCtx.length;
  const headingSuffix = sectionHeading ? ` ${sectionHeading}` : '';
  lines.push(
    `@@ -${oldStartLine},${oldCount} +${newStartLine},${newCount} @@${headingSuffix}`
  );
  for (const l of beforeCtx) lines.push(` ${l}`);
  for (const l of oldLines) lines.push(`-${l}`);
  for (const l of newLines) lines.push(`+${l}`);
  for (const l of afterCtx) lines.push(` ${l}`);
  return lines.join('\n');
}

/**
 * Build the match-site cheat sheet for a set of survivors.
 */
function buildMatchSites(
  survivors: MatchSpan[],
  fileLines: string[],
  hunk: PatchHunk
): MatchSite[] {
  const { oldLines, newLines, contextBefore, contextAfter, sectionHeading } =
    hunk;
  return survivors.map(m => {
    const ctxStart = Math.max(0, m.start - CHEAT_SHEET_CONTEXT_LINES);
    const ctxEnd = Math.min(
      fileLines.length,
      m.end + CHEAT_SHEET_CONTEXT_LINES
    );
    const context: string[] = [];
    for (let i = ctxStart; i < ctxEnd; i++) {
      context.push(`${i + 1}: ${fileLines[i]}`);
    }
    const reworkedHunk = buildReworkedHunk(
      fileLines,
      m,
      survivors.filter(s => s !== m),
      oldLines,
      newLines,
      contextBefore,
      contextAfter,
      sectionHeading
    );
    return { line: m.start + 1, context, reworkedHunk };
  });
}

/**
 * Build a Type 1 failure: multiple matches survive all narrowing.
 */
export function buildType1Failure(
  hunkIndex: number,
  survivors: MatchSpan[],
  fileLines: string[],
  hunk: PatchHunk
): PatchError {
  return {
    hunkIndex,
    message: `Multiple matches (${survivors.length}) survived all narrowing`,
    detail: `The old code matched ${survivors.length} locations and the context/heading couldn't disambiguate. See each match below with a reworked hunk that would uniquely target it.`,
    anchors: hunk.anchors,
    failureType: 'type1',
    matchSites: buildMatchSites(survivors, fileLines, hunk),
  };
}

/**
 * Build a Type 2 failure: zero matches at step 1.5 (old code not in file).
 */
export function buildType2Failure(
  hunkIndex: number,
  hunk: PatchHunk,
  fileLines: string[]
): PatchError {
  const suggestions = findFuzzySuggestions(fileLines, hunk.oldLines);
  const detail =
    suggestions.length > 0
      ? `The old code was not found in the file in any form. The closest candidates (by edit distance) are listed below — you may have meant one of these.`
      : `The old code was not found in the file in any form, and no close candidates could be identified (the old code may be too generic or the file has changed substantially). Re-read the file with file__read to see the current contents.`;
  return {
    hunkIndex,
    message: `Old code not found in file`,
    detail,
    anchors: hunk.anchors,
    failureType: 'type2',
    suggestions,
  };
}

/**
 * Build a Type 3 failure: a later step over-narrowed to zero, but an earlier
 * step had multiples. Unrolls to the last multiple-match step and reports
 * like Type 1.
 */
export function buildType3Failure(
  hunkIndex: number,
  lastMultiple: MatchSpan[],
  fileLines: string[],
  hunk: PatchHunk
): PatchError {
  const err = buildType1Failure(hunkIndex, lastMultiple, fileLines, hunk);
  err.failureType = 'type3';
  err.message = `Narrowing over-eliminated all matches; unrolled to last multiple-match step`;
  err.detail = `A later narrowing step eliminated all candidates, so the matcher unrolled to the last step that had multiple matches (${lastMultiple.length}). See each match below with a reworked hunk.`;
  return err;
}
