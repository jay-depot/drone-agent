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

  // Render the context window that a hunk anchored at `m` would carry, given
  // the current growth. Two candidates are still ambiguous when their windows
  // are textually identical (the change zone is the same at every candidate,
  // so only surrounding context can tell them apart).
  const windowText = (m: MatchSpan): string => {
    const bs = Math.max(0, m.start - contextBefore.length - extraBefore);
    const ae = Math.min(
      fileLines.length,
      m.end + contextAfter.length + extraAfter
    );
    return fileLines.slice(bs, ae).join('\n');
  };

  const isUnique = (): boolean => {
    const mine = windowText(match);
    for (const other of otherMatches) {
      if (other.start === match.start && other.end === match.end) continue;
      if (windowText(other) === mine) return false;
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
 * Build a failure for an ambiguous pure-insertion hunk: the hunk has no old
 * lines, so its position rests entirely on context, and that context matched
 * more than one place. Guessing would insert in the wrong location while
 * reporting success, so we surface each candidate instead. Each site is a
 * zero-width span at the candidate insertion index; `buildMatchSites` renders
 * the surrounding context and a reworked hunk that inserts at that point.
 */
export function buildInsertionAmbiguityFailure(
  hunkIndex: number,
  insertionPoints: number[],
  fileLines: string[],
  hunk: PatchHunk
): PatchError {
  const survivors: MatchSpan[] = insertionPoints.map(point => ({
    start: point,
    end: point,
    fuzz: 0,
  }));
  return {
    hunkIndex,
    message: `Ambiguous insertion point (${insertionPoints.length} candidates)`,
    detail:
      `This hunk only inserts lines (it has no \`-\` lines), so its position is ` +
      `fixed entirely by the surrounding context — and that context matches ` +
      `${insertionPoints.length} places. Add more context lines, or include a ` +
      `line of the code you are inserting next to as a \`-\` line, so the ` +
      `anchor is unique. Each candidate is shown below with a reworked hunk ` +
      `that inserts at that point.`,
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
      ? `The old code was not found in any form. The closest candidates (by edit distance) are listed below — you may have meant one of these.`
      : `The old code was not found in any form, and no close candidates could be identified (the old code may be too generic or the target has changed substantially).`;
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

/**
 * Format a PatchError into an LLM-friendly error message. Each failure type
 * is reported differently:
 *
 *   Type 1 (multiple matches): a cheat sheet listing each match with line
 *     numbers + surrounding context, plus a reworked hunk that would uniquely
 *     target each one (the LLM can crib and resubmit).
 *   Type 2 (old code not found): up to 5 Levenshtein-closest file spans with
 *     location + actual content; or a plain "not found" message if the old
 *     code is too generic.
 *   Type 3 (narrowing over-eliminated): unrolled to the last multiple-match
 *     step, then reported like Type 1.
 */
export function formatPatchError(e: PatchError): string {
  const tag = `Hunk ${e.hunkIndex}:`;

  if (e.failureType === 'type2') {
    const suggestions = e.suggestions ?? [];
    if (suggestions.length === 0) {
      return (
        `${tag} The old code (the \`-\` lines) was not found in any form.\n` +
        `  ${e.detail}`
      );
    }
    const lines = suggestions.map(
      s =>
        `  - line ${s.line} (distance ${s.distance}):\n` +
        s.content
          .split('\n')
          .map(l => `      ${l}`)
          .join('\n')
    );
    return (
      `${tag} The old code (the \`-\` lines) was not found.\n` +
      `  ${e.detail}\n` +
      `  Closest candidates:\n${lines.join('\n')}`
    );
  }

  // Type 1 and Type 3 share the cheat-sheet format.
  const sites = e.matchSites ?? [];
  const siteBlocks = sites.map((site, idx) => {
    const ctx = site.context.map(l => `    ${l}`).join('\n');
    return (
      `  Match ${idx + 1} (line ${site.line}):\n` +
      `${ctx}\n` +
      `  Reworked hunk to target this match:\n` +
      '  ```diff\n' +
      site.reworkedHunk
        .split('\n')
        .map(l => `  ${l}`)
        .join('\n') +
      '\n  ```'
    );
  });
  return `${tag} ${e.message}\n  ${e.detail}\n\n${siteBlocks.join('\n\n')}`;
}
