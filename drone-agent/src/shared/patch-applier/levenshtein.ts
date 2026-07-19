/**
 * Levenshtein edit distance on collapsed forms, used by Type 2 failure
 * reporting to suggest the closest file spans to a not-found old change zone.
 */

import type { FuzzySuggestion } from './types.js';
import { collapseWhitespace } from './fuzz.js';

/**
 * Compute Levenshtein edit distance between two strings.
 * Classic O(n*m) dynamic programming; fine for our collapsed-form lengths.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Find the top candidate file spans whose collapsed form is closest
 * (by Levenshtein) to the collapsed oldLines. Used for Type 2 failure
 * suggestions. Caps at 5; if more than 5 equally-close candidates exist,
 * returns an empty array (signal to skip suggestions — oldLines too generic).
 */
export function findFuzzySuggestions(
  fileLines: string[],
  oldLines: string[]
): FuzzySuggestion[] {
  const { collapsed: oldCollapsed } = collapseWhitespace(oldLines);
  if (oldCollapsed.length === 0) return [];

  const targetLen = oldCollapsed.length;
  const candidates: { line: number; content: string; distance: number }[] = [];

  // Sliding window over the file. Window length varies to catch line-break
  // reflow: try windows from 1 line up to oldLines.length + a margin.
  const minWindow = Math.max(1, oldLines.length - 5);
  const maxWindow = oldLines.length + 5;
  for (let w = minWindow; w <= maxWindow; w++) {
    for (let i = 0; i + w <= fileLines.length; i++) {
      const windowLines = fileLines.slice(i, i + w);
      const { collapsed: windowCollapsed } = collapseWhitespace(windowLines);
      // Only compare windows of similar collapsed length to bound work.
      if (
        windowCollapsed.length < targetLen - Math.floor(targetLen * 0.5) ||
        windowCollapsed.length > targetLen + Math.floor(targetLen * 0.5)
      ) {
        continue;
      }
      const distance = levenshtein(oldCollapsed, windowCollapsed);
      candidates.push({
        line: i + 1,
        content: windowLines.join('\n'),
        distance,
      });
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);

  if (candidates.length === 0) return [];
  const top5 = candidates.slice(0, 5);
  if (candidates.length > 5) {
    // If many candidates tie at the 5th-best distance, the oldLines are too
    // generic — return no suggestions rather than a noisy pile.
    const fifthDistance = top5[4].distance;
    const tiedCount = candidates.filter(
      c => c.distance === fifthDistance
    ).length;
    if (tiedCount > 1) return [];
  }
  return top5;
}
