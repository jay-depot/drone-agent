/**
 * Fuzz-level normalization helpers shared across the matching cascade.
 *
 * Levels (in loosening order):
 *   0:   Exact match (no normalization)
 *   1:   Trim trailing whitespace
 *   100: Strip ALL whitespace within the line
 *   200: Aggressive — collapse ALL whitespace including newlines (handled by
 *        collapseWhitespace, which is newline-aware and produces a single
 *        string with a back-map to originating line indices)
 */

import type { FuzzLevel } from '../diff-renderer.js';

/** The aggressive fuzz level (collapses all whitespace including newlines). */
export const AGGRESSIVE_FUZZ = 200 as const satisfies FuzzLevel;

/** All fuzz levels in loosening order (used by steps 2 and 3). */
export const FUZZ_LEVELS: FuzzLevel[] = [0, 1, 100, AGGRESSIVE_FUZZ];

/**
 * Normalize a line for matching at a given fuzz level.
 *
 * Level 0:   No normalization (exact match)
 * Level 1:   Strip trailing whitespace
 * Level 100: Strip ALL whitespace within the line
 * Level 200: Aggressive — strips all whitespace (newline-aware collapsing is
 *            handled separately by collapseWhitespace for substring matching)
 */
export function normalizeLine(line: string, level: FuzzLevel): string {
  switch (level) {
    case 0:
      return line;
    case 1:
      return line.replace(/\s+$/, '');
    case 100:
    case AGGRESSIVE_FUZZ:
      return line.replace(/\s+/g, '');
  }
}

/**
 * Collapse all whitespace (including newlines) in a block of lines into a
 * single string with no internal whitespace. Used for aggressive format-aware
 * fuzz (step 1.5 and the aggressive level of steps 2/3).
 *
 * Returns a map from positions in the collapsed string back to the
 * originating file line index, so substring matches can be translated back
 * to file-line spans.
 */
export function collapseWhitespace(lines: string[]): {
  collapsed: string;
  /** indexIntoCollapsed → fileLineIndex (length = collapsed.length + 1) */
  lineMap: number[];
} {
  let collapsed = '';
  const lineMap: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (!/\s/.test(ch)) {
        lineMap.push(i);
        collapsed += ch;
      }
    }
  }
  // Sentinel: position === collapsed.length maps to lines.length
  lineMap.push(lines.length);
  return { collapsed, lineMap };
}

/**
 * Check if an array of expected lines matches an array of actual lines
 * at the given fuzz level (line-by-line; not for aggressive fuzz which uses
 * collapseWhitespace for substring matching).
 */
export function linesMatch(
  expected: string[],
  actual: string[],
  level: FuzzLevel
): boolean {
  if (expected.length !== actual.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (normalizeLine(expected[i], level) !== normalizeLine(actual[i], level)) {
      return false;
    }
  }
  return true;
}
