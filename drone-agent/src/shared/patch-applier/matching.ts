/**
 * Matching helpers for the patch-applier cascade.
 *
 * Step 1 (exact oldLines match) and step 1.5 (aggressive format-aware fuzz)
 * find all occurrences of the old change zone in the file. Step 2 (context
 * narrowing) and step 3 (section-heading narrowing) filter survivors with a
 * loosening cascade.
 */

import type { FuzzLevel } from '../diff-renderer.js';
import type { MatchSpan, NarrowResult } from './types.js';
import {
  AGGRESSIVE_FUZZ,
  collapseWhitespace,
  FUZZ_LEVELS,
  linesMatch,
  normalizeLine,
} from './fuzz.js';

// ── Step 1: exact oldLines match ──────────────────────────────────────

/**
 * Find all occurrences of the old change zone (oldLines) as a contiguous run
 * in the file, using exact line-by-line matching.
 */
export function findExactOldLinesMatches(
  fileLines: string[],
  oldLines: string[]
): MatchSpan[] {
  const matches: MatchSpan[] = [];
  if (oldLines.length === 0) return matches;
  for (let i = 0; i <= fileLines.length - oldLines.length; i++) {
    if (linesMatch(oldLines, fileLines.slice(i, i + oldLines.length), 0)) {
      matches.push({ start: i, end: i + oldLines.length, fuzz: 0 });
    }
  }
  return matches;
}

// ── Step 1.5: aggressive format-aware fuzz on oldLines ────────────────

/**
 * Find all occurrences of the old change zone using aggressive format-aware
 * fuzz: collapse ALL whitespace (including newlines) on both sides and
 * substring-search the collapsed oldLines in the collapsed file.
 *
 * Supports variable-length spans in both directions: a 1-line oldLines block
 * can match a multi-line file span (e.g., prettier wrapped it), and a
 * multi-line oldLines block can match a 1-line file span (e.g., the formatter
 * joined lines). The matched span [start..end) in file lines is what gets
 * replaced by newLines.
 */
export function findAggressiveOldLinesMatches(
  fileLines: string[],
  oldLines: string[]
): MatchSpan[] {
  if (oldLines.length === 0) return [];

  const { collapsed: fileCollapsed, lineMap: fileLineMap } =
    collapseWhitespace(fileLines);
  const { collapsed: oldCollapsed } = collapseWhitespace(oldLines);

  if (oldCollapsed.length === 0) return [];

  const matches: MatchSpan[] = [];
  let searchFrom = 0;
  while (searchFrom <= fileCollapsed.length - oldCollapsed.length) {
    const idx = fileCollapsed.indexOf(oldCollapsed, searchFrom);
    if (idx === -1) break;
    // Map collapsed-string indices back to file-line indices. The match
    // spans file lines [startLine..endLine] inclusive; convert to half-open.
    const startLine = fileLineMap[idx];
    const lastCollapsedIdx = idx + oldCollapsed.length - 1;
    const endLine = fileLineMap[lastCollapsedIdx];
    matches.push({
      start: startLine,
      end: endLine + 1,
      fuzz: AGGRESSIVE_FUZZ,
    });
    searchFrom = idx + 1;
  }
  return matches;
}

// ── Step 2: context narrowing ─────────────────────────────────────────

/**
 * Filter survivors by context lines at a single fuzz level. Adjacency is
 * immediate-before/after in the same normalization used to find the match.
 *
 * For exact (step 1) matches, adjacency is line-exact: contextBefore must
 * immediately precede match.start and contextAfter must immediately follow
 * match.end.
 *
 * For aggressive (step 1.5) matches, adjacency is on the collapsed form:
 * the collapsed contextBefore must be a suffix of the collapsed file content
 * immediately before the match span, and contextAfter must be a prefix of
 * the collapsed file content immediately after.
 */
function narrowByContextAtLevel(
  fileLines: string[],
  survivors: MatchSpan[],
  contextBefore: string[],
  contextAfter: string[],
  level: FuzzLevel
): MatchSpan[] {
  const result: MatchSpan[] = [];
  for (const m of survivors) {
    if (level === AGGRESSIVE_FUZZ) {
      const beforeRegion = fileLines.slice(0, m.start);
      const afterRegion = fileLines.slice(m.end);
      const { collapsed: beforeCollapsed } = collapseWhitespace(beforeRegion);
      const { collapsed: afterCollapsed } = collapseWhitespace(afterRegion);
      const { collapsed: beforeCtxCollapsed } =
        collapseWhitespace(contextBefore);
      const { collapsed: afterCtxCollapsed } = collapseWhitespace(contextAfter);
      if (
        beforeCollapsed.endsWith(beforeCtxCollapsed) &&
        afterCollapsed.startsWith(afterCtxCollapsed)
      ) {
        result.push(m);
      }
    } else {
      const beforeOk =
        contextBefore.length === 0 ||
        (m.start - contextBefore.length >= 0 &&
          linesMatch(
            contextBefore,
            fileLines.slice(m.start - contextBefore.length, m.start),
            level
          ));
      const afterOk =
        contextAfter.length === 0 ||
        (m.end + contextAfter.length <= fileLines.length &&
          linesMatch(
            contextAfter,
            fileLines.slice(m.end, m.end + contextAfter.length),
            level
          ));
      if (beforeOk && afterOk) result.push(m);
    }
  }
  return result;
}

/**
 * Drop outer context lines progressively: `dropCount` lines are removed from
 * the outer edge of each side before matching.
 */
function narrowByDroppedContext(
  fileLines: string[],
  survivors: MatchSpan[],
  contextBefore: string[],
  contextAfter: string[],
  level: FuzzLevel,
  dropCount: number
): MatchSpan[] {
  const trimmedBefore =
    dropCount >= contextBefore.length
      ? []
      : contextBefore.slice(dropCount, contextBefore.length - dropCount);
  const trimmedAfter =
    dropCount >= contextAfter.length
      ? []
      : contextAfter.slice(dropCount, contextAfter.length - dropCount);
  return narrowByContextAtLevel(
    fileLines,
    survivors,
    trimmedBefore,
    trimmedAfter,
    level
  );
}

/**
 * Require fewer context sides: only contextBefore, or only contextAfter.
 */
function narrowBySingleSide(
  fileLines: string[],
  survivors: MatchSpan[],
  contextBefore: string[],
  contextAfter: string[],
  level: FuzzLevel,
  side: 'before' | 'after'
): MatchSpan[] {
  const before = side === 'before' ? contextBefore : [];
  const after = side === 'after' ? contextAfter : [];
  return narrowByContextAtLevel(fileLines, survivors, before, after, level);
}

/**
 * Run the full context-narrowing loosening cascade (step 2).
 *
 * Cascade order:
 *   1. Exact context match
 *   2. Trim-trailing-whitespace fuzz on context
 *   3. Strip-all-whitespace fuzz on context
 *   4. Aggressive format-aware fuzz on context
 *   5. Drop outer context lines progressively (at each prior fuzz level)
 *   6. Require fewer context sides (only before, or only after)
 */
export function narrowByContextCascade(
  fileLines: string[],
  survivors: MatchSpan[],
  contextBefore: string[],
  contextAfter: string[]
): NarrowResult {
  let lastMultiple = survivors;
  const hasContext = contextBefore.length > 0 || contextAfter.length > 0;

  // Levels 1-4: fuzz levels with full context
  for (const level of FUZZ_LEVELS) {
    if (survivors.length <= 1) break;
    lastMultiple = survivors;
    const narrowed = narrowByContextAtLevel(
      fileLines,
      survivors,
      contextBefore,
      contextAfter,
      level
    );
    if (narrowed.length === 1) return { survivors: narrowed, lastMultiple };
    if (narrowed.length > 1) {
      survivors = narrowed;
      lastMultiple = narrowed;
    }
    // narrowed.length === 0 → try next level with previous survivors
  }

  if (!hasContext) return { survivors, lastMultiple };

  // Level 5: drop outer context lines progressively (at each fuzz level)
  const maxDrop = Math.max(contextBefore.length, contextAfter.length);
  for (const level of FUZZ_LEVELS) {
    for (let drop = 1; drop < maxDrop; drop++) {
      if (survivors.length <= 1) break;
      lastMultiple = survivors;
      const narrowed = narrowByDroppedContext(
        fileLines,
        survivors,
        contextBefore,
        contextAfter,
        level,
        drop
      );
      if (narrowed.length === 1) return { survivors: narrowed, lastMultiple };
      if (narrowed.length > 1) {
        survivors = narrowed;
        lastMultiple = narrowed;
      }
    }
  }

  // Level 6: require fewer context sides (at each fuzz level)
  for (const level of FUZZ_LEVELS) {
    for (const side of ['before', 'after'] as const) {
      if (survivors.length <= 1) break;
      lastMultiple = survivors;
      const narrowed = narrowBySingleSide(
        fileLines,
        survivors,
        contextBefore,
        contextAfter,
        level,
        side
      );
      if (narrowed.length === 1) return { survivors: narrowed, lastMultiple };
      if (narrowed.length > 1) {
        survivors = narrowed;
        lastMultiple = narrowed;
      }
    }
  }

  return { survivors, lastMultiple };
}

// ── Step 3: section-heading narrowing ────────────────────────────────

/**
 * Check whether a section heading matches a file line at a given fuzz level.
 * For levels 0/1/100 this is a whole-line match. For aggressive fuzz it's a
 * substring match on the collapsed form (so `function foo(` matches
 * `export async function foo(arg1, arg2) {`).
 */
function headingMatchesLine(
  heading: string,
  fileLine: string,
  level: FuzzLevel
): boolean {
  if (level === AGGRESSIVE_FUZZ) {
    const { collapsed: headingCollapsed } = collapseWhitespace([heading]);
    const { collapsed: lineCollapsed } = collapseWhitespace([fileLine]);
    return lineCollapsed.includes(headingCollapsed);
  }
  return normalizeLine(heading, level) === normalizeLine(fileLine, level);
}

/** Window (lines before the match start) to scan for a section heading. */
const HEADING_WINDOW = 5;

/**
 * Filter survivors by section heading at a given fuzz level. The heading must
 * match some file line within a few lines before the match start (section
 * headings usually appear on or just before the change zone).
 */
function narrowByHeadingAtLevel(
  fileLines: string[],
  survivors: MatchSpan[],
  heading: string,
  level: FuzzLevel
): MatchSpan[] {
  const result: MatchSpan[] = [];
  for (const m of survivors) {
    const windowStart = Math.max(0, m.start - HEADING_WINDOW);
    let found = false;
    for (let i = windowStart; i <= m.start; i++) {
      if (headingMatchesLine(heading, fileLines[i], level)) {
        found = true;
        break;
      }
    }
    if (found) result.push(m);
  }
  return result;
}

/**
 * Run the section-heading narrowing loosening cascade (step 3).
 * Only runs if a section heading is present; skipped entirely otherwise.
 */
export function narrowByHeadingCascade(
  fileLines: string[],
  survivors: MatchSpan[],
  sectionHeading: string
): NarrowResult {
  let lastMultiple = survivors;
  for (const level of FUZZ_LEVELS) {
    if (survivors.length <= 1) break;
    lastMultiple = survivors;
    const narrowed = narrowByHeadingAtLevel(
      fileLines,
      survivors,
      sectionHeading,
      level
    );
    if (narrowed.length === 1) return { survivors: narrowed, lastMultiple };
    if (narrowed.length > 1) {
      survivors = narrowed;
      lastMultiple = narrowed;
    }
  }
  return { survivors, lastMultiple };
}

// ── lineHint tie-breaking ─────────────────────────────────────────────

/**
 * Sort survivors by proximity to the line hint (closest first). Used as a
 * tie-breaker when multiple matches are otherwise equivalent.
 */
export function sortByLineHint(
  survivors: MatchSpan[],
  lineHint: number | undefined
): MatchSpan[] {
  if (lineHint === undefined || survivors.length <= 1) return survivors;
  const hintIndex = lineHint - 1;
  return [...survivors].sort(
    (a, b) => Math.abs(a.start - hintIndex) - Math.abs(b.start - hintIndex)
  );
}

// ── Pure-insertion locator ────────────────────────────────────────────

/**
 * Locate the insertion point for a pure-insertion hunk (empty oldLines).
 * Searches for the contextBefore block; the insertion happens immediately
 * after it. Falls back to contextAfter (insertion immediately before it).
 * Returns the 0-based insertion index, or null if no context matched.
 */
export function locatePureInsertion(
  fileLines: string[],
  contextBefore: string[],
  contextAfter: string[],
  lineHint?: number
): number | null {
  if (contextBefore.length > 0) {
    for (let i = 0; i <= fileLines.length - contextBefore.length; i++) {
      if (
        linesMatch(
          contextBefore,
          fileLines.slice(i, i + contextBefore.length),
          0
        )
      ) {
        return i + contextBefore.length;
      }
    }
    for (const level of [1, 100] as FuzzLevel[]) {
      for (let i = 0; i <= fileLines.length - contextBefore.length; i++) {
        if (
          linesMatch(
            contextBefore,
            fileLines.slice(i, i + contextBefore.length),
            level
          )
        ) {
          return i + contextBefore.length;
        }
      }
    }
  }
  if (contextAfter.length > 0) {
    for (let i = 0; i <= fileLines.length - contextAfter.length; i++) {
      if (
        linesMatch(contextAfter, fileLines.slice(i, i + contextAfter.length), 0)
      ) {
        return i;
      }
    }
    for (const level of [1, 100] as FuzzLevel[]) {
      for (let i = 0; i <= fileLines.length - contextAfter.length; i++) {
        if (
          linesMatch(
            contextAfter,
            fileLines.slice(i, i + contextAfter.length),
            level
          )
        ) {
          return i;
        }
      }
    }
  }
  // No context at all — if file is empty, insert at start.
  if (fileLines.length === 0) return 0;
  // lineHint as last resort
  if (
    lineHint !== undefined &&
    lineHint >= 1 &&
    lineHint <= fileLines.length + 1
  ) {
    return lineHint - 1;
  }
  return null;
}

// Re-export for callers that need it (e.g. tests).
export { normalizeLine };
