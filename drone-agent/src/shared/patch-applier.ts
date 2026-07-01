/**
 * Patch applier — core patch matching and application logic for
 * content-anchor-based diffs.
 *
 * Implements a 3-level progressive matching cascade:
 *   Level 0:   Exact match of all lines
 *   Level 1:   Strip trailing whitespace from all lines
 *   Level 100: Strip ALL whitespace from all lines
 *
 * Inspired by OpenAI's V4A diff format approach.
 */

import type { FuzzLevel } from './diff-renderer.js';

// ── Types ──────────────────────────────────────────────────────────────

/** A single hunk in a content-anchor-based patch */
export interface PatchHunk {
  /** Content anchor line(s) — code that uniquely identifies the location */
  anchors: string[];
  /** Lines expected before the edit point (context) */
  contextBefore: string[];
  /** Lines to remove (old code) */
  oldLines: string[];
  /** Lines to insert (new code) */
  newLines: string[];
  /** Lines expected after the edit point (context) */
  contextAfter: string[];
}

/** Result of applying a single hunk */
export interface AppliedHunk {
  /** The anchors that were used to locate this hunk */
  anchors: string[];
  /** Fuzz level used to match this hunk */
  fuzz: FuzzLevel;
  /** 1-based line number where the hunk was applied */
  appliedAtLine: number;
}

/** Error information for a failed hunk */
export interface PatchError {
  /** Index of the hunk in the original array (0-based) */
  hunkIndex: number;
  /** Short human-readable error message */
  message: string;
  /** Detailed explanation including what was found vs expected */
  detail: string;
  /** The anchor lines that were used to search */
  anchors: string[];
  /** What was found at the best match location (for context mismatch) */
  foundContextBefore?: string[];
  foundContextAfter?: string[];
  foundOldLines?: string[];
}

/** Overall result of applying a patch */
export interface PatchResult {
  /** Whether all hunks were applied successfully */
  success: boolean;
  /** Hunks that were successfully applied */
  appliedHunks: AppliedHunk[];
  /** Hunks that failed to apply */
  errors: PatchError[];
}

// ── Matching helpers ──────────────────────────────────────────────────

/**
 * Normalize a line for matching at a given fuzz level.
 *
 * Level 0:   No normalization (exact match)
 * Level 1:   Strip trailing whitespace (CR/LF normalization)
 * Level 100: Strip ALL whitespace (most aggressive)
 */
function normalizeLine(line: string, level: FuzzLevel): string {
  switch (level) {
    case 0:
      return line;
    case 1:
      return line.replace(/\s+$/, '');
    case 100:
      return line.replace(/\s+/g, '');
  }
}

/**
 * Check if an array of expected lines matches an array of actual lines
 * at the given fuzz level.
 */
function linesMatch(
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

/**
 * Find all occurrences of an anchor line in the file.
 * Returns 0-based indices.
 */
function findAnchorOccurrences(
  lines: string[],
  anchor: string,
  level: FuzzLevel
): number[] {
  const occurrences: number[] = [];
  const normalizedAnchor = normalizeLine(anchor, level);
  for (let i = 0; i < lines.length; i++) {
    if (normalizeLine(lines[i], level) === normalizedAnchor) {
      occurrences.push(i);
    }
  }
  return occurrences;
}

/**
 * Narrow anchor occurrences by matching subsequent anchors.
 * Each subsequent anchor must appear on a line after the previous one.
 */
function narrowByAnchors(
  lines: string[],
  anchors: string[],
  level: FuzzLevel,
  candidateStarts: number[]
): number[] {
  if (anchors.length <= 1) return candidateStarts;

  let candidates = candidateStarts;

  for (let ai = 1; ai < anchors.length; ai++) {
    const nextCandidates: number[] = [];
    const normalizedAnchor = normalizeLine(anchors[ai], level);

    for (const start of candidates) {
      // Search from start+1 to end of file for the next anchor
      for (let i = start + 1; i < lines.length; i++) {
        if (normalizeLine(lines[i], level) === normalizedAnchor) {
          nextCandidates.push(i);
          break; // Take the first match after the previous anchor
        }
      }
    }

    candidates = nextCandidates;
    if (candidates.length === 0) break;
  }

  return candidates;
}

/**
 * Result of a context match attempt.
 */
interface ContextMatchResult {
  /** 0-based index of the edit point */
  editIndex: number;
  /** Fuzz level used */
  fuzz: FuzzLevel;
}

/**
 * Try to match a full context block (contextBefore + oldLines + contextAfter)
 * at a given anchor position in the file.
 *
 * Tries two possible edit point positions:
 *   1. At the anchor line (anchorIndex) — the anchor itself is being replaced
 *   2. After the anchor line (anchorIndex + 1) — the anchor is context above
 *
 * Returns the edit index and fuzz level, or null if no level matched.
 */
function tryMatchContext(
  lines: string[],
  contextBefore: string[],
  oldLines: string[],
  contextAfter: string[],
  anchorIndex: number
): ContextMatchResult | null {
  // Try two possible edit point positions
  const editPositions = [anchorIndex, anchorIndex + 1];
  const levels: FuzzLevel[] = [0, 1, 100];

  for (const editStart of editPositions) {
    const contextBeforeStart = editStart - contextBefore.length;

    // Check bounds
    if (contextBeforeStart < 0) continue;
    if (editStart + oldLines.length + contextAfter.length > lines.length) continue;

    for (const level of levels) {
      const beforeSlice = lines.slice(contextBeforeStart, editStart);
      const oldSlice = lines.slice(editStart, editStart + oldLines.length);
      const afterSlice = lines.slice(
        editStart + oldLines.length,
        editStart + oldLines.length + contextAfter.length
      );

      if (
        linesMatch(contextBefore, beforeSlice, level) &&
        linesMatch(oldLines, oldSlice, level) &&
        linesMatch(contextAfter, afterSlice, level)
      ) {
        return { editIndex: editStart, fuzz: level };
      }
    }
  }

  return null;
}

/**
 * Try to match a full context block (contextBefore + oldLines + contextAfter)
 * anywhere in the file (no anchors). Returns the 0-based index of the edit
 * point and the fuzz level, or null if no match found.
 */
function findContextAnywhere(
  lines: string[],
  contextBefore: string[],
  oldLines: string[],
  contextAfter: string[]
): ContextMatchResult | null {
  const totalLen =
    contextBefore.length + oldLines.length + contextAfter.length;
  if (totalLen === 0) return null;

  const levels: FuzzLevel[] = [0, 1, 100];

  for (const level of levels) {
    for (let i = 0; i <= lines.length - totalLen; i++) {
      const beforeSlice = lines.slice(i, i + contextBefore.length);
      const oldSlice = lines.slice(
        i + contextBefore.length,
        i + contextBefore.length + oldLines.length
      );
      const afterSlice = lines.slice(
        i + contextBefore.length + oldLines.length,
        i + contextBefore.length + oldLines.length + contextAfter.length
      );

      if (
        linesMatch(contextBefore, beforeSlice, level) &&
        linesMatch(oldLines, oldSlice, level) &&
        linesMatch(contextAfter, afterSlice, level)
      ) {
        return {
          editIndex: i + contextBefore.length, // edit point
          fuzz: level,
        };
      }
    }
  }

  return null;
}

// ── Main apply function ───────────────────────────────────────────────

/**
 * Apply a set of content-anchor-based hunks to a file's lines.
 *
 * Hunks are applied bottom-up to avoid position invalidation.
 * Returns a PatchResult with details about what was applied and any errors.
 *
 * @param lines - The file content as an array of lines (no trailing newline)
 * @param hunks - The hunks to apply
 * @returns PatchResult with applied hunks and errors
 */
export function applyPatch(
  lines: string[],
  hunks: PatchHunk[]
): PatchResult {
  const appliedHunks: AppliedHunk[] = [];
  const errors: PatchError[] = [];

  // Work on a copy so we can apply bottom-up
  const workingLines = [...lines];

  // Process hunks bottom-up to avoid position invalidation
  // We need to track the original indices for error reporting
  const indexedHunks = hunks.map((hunk, i) => ({ hunk, originalIndex: i }));

  // We'll apply in reverse order, but we need to track where each hunk
  // was found in the CURRENT state of workingLines (which changes as we apply)
  // So we process from bottom to top
  for (let hi = indexedHunks.length - 1; hi >= 0; hi--) {
    const { hunk, originalIndex } = indexedHunks[hi];
    const { anchors, contextBefore, oldLines, newLines, contextAfter } = hunk;

    let editIndex: number | null = null;
    let fuzz: FuzzLevel = 0;

    if (anchors.length > 0) {
      // Strategy 1: Use anchors to locate the edit site
      // Find all occurrences of the first anchor
      let candidates = findAnchorOccurrences(workingLines, anchors[0], 0);

      // If no exact anchor match, try fuzzy
      if (candidates.length === 0) {
        candidates = findAnchorOccurrences(workingLines, anchors[0], 1);
      }
      if (candidates.length === 0) {
        candidates = findAnchorOccurrences(workingLines, anchors[0], 100);
      }

      if (candidates.length === 0) {
        errors.push({
          hunkIndex: originalIndex,
          message: `Anchor not found: "${anchors[0]}"`,
          detail: `The anchor line "${anchors[0]}" does not appear anywhere in the file. Check for typos, indentation differences, or whitespace issues.`,
          anchors,
        });
        continue;
      }

      // Narrow by subsequent anchors
      if (anchors.length > 1) {
        candidates = narrowByAnchors(workingLines, anchors, 0, candidates);
        if (candidates.length === 0) {
          // Try fuzzy narrowing
          candidates = narrowByAnchors(workingLines, anchors, 1, candidates);
        }
        if (candidates.length === 0) {
          candidates = narrowByAnchors(workingLines, anchors, 100, candidates);
        }
      }

      if (candidates.length === 0) {
        errors.push({
          hunkIndex: originalIndex,
          message: `Anchor chain not found: "${anchors.join('" > "')}"`,
          detail: `The full anchor chain could not be matched in sequence. The first anchor "${anchors[0]}" was found, but subsequent anchors could not be found after it.`,
          anchors,
        });
        continue;
      }

      // Try to match context at each candidate anchor position
      let matched = false;
      for (const candidate of candidates) {
        const result = tryMatchContext(
          workingLines,
          contextBefore,
          oldLines,
          contextAfter,
          candidate
        );
        if (result !== null) {
          editIndex = result.editIndex;
          fuzz = result.fuzz;
          matched = true;
          break;
        }
      }

      if (!matched) {
        // Build detailed error with what was found at the first candidate
        const firstCandidate = candidates[0];
        const editStart = firstCandidate + 1;
        const contextBeforeStart = editStart - contextBefore.length;

        const foundBefore =
          contextBeforeStart >= 0
            ? workingLines.slice(contextBeforeStart, editStart)
            : [];
        const foundOld =
          editStart + oldLines.length <= workingLines.length
            ? workingLines.slice(editStart, editStart + oldLines.length)
            : [];
        const foundAfter =
          editStart + oldLines.length + contextAfter.length <=
          workingLines.length
            ? workingLines.slice(
                editStart + oldLines.length,
                editStart + oldLines.length + contextAfter.length
              )
            : [];

        errors.push({
          hunkIndex: originalIndex,
          message: `Context does not match at anchor location`,
          detail: `Found ${candidates.length} anchor match(es) but context didn't match at any. At the first anchor occurrence:\n` +
            `  Expected contextBefore: ${JSON.stringify(contextBefore)}\n` +
            `  Found contextBefore:    ${JSON.stringify(foundBefore)}\n` +
            `  Expected oldLines:      ${JSON.stringify(oldLines)}\n` +
            `  Found oldLines:         ${JSON.stringify(foundOld)}\n` +
            `  Expected contextAfter:  ${JSON.stringify(contextAfter)}\n` +
            `  Found contextAfter:     ${JSON.stringify(foundAfter)}`,
          anchors,
          foundContextBefore: foundBefore,
          foundContextAfter: foundAfter,
          foundOldLines: foundOld,
        });
        continue;
      }
    } else {
      // Strategy 2: No anchors — search the whole file for the context
      const result = findContextAnywhere(
        workingLines,
        contextBefore,
        oldLines,
        contextAfter
      );

      if (result === null) {
        errors.push({
          hunkIndex: originalIndex,
          message: `Context not found anywhere in file`,
          detail:
            `No anchors provided and the full context block ` +
            `(contextBefore + oldLines + contextAfter) could not be matched ` +
            `anywhere in the file. Try adding anchors to narrow the search.`,
          anchors,
        });
        continue;
      }

      editIndex = result.editIndex;
      fuzz = result.fuzz;
    }

    // Apply the hunk
    if (editIndex !== null) {
      // Remove oldLines and insert newLines
      workingLines.splice(editIndex, oldLines.length, ...newLines);

      appliedHunks.push({
        anchors,
        fuzz,
        appliedAtLine: editIndex + 1, // 1-based
      });
    }
  }

  return {
    success: errors.length === 0,
    appliedHunks,
    errors,
  };
}
