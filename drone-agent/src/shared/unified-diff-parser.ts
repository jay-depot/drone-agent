/**
 * Unified diff parser — converts a standard unified diff string (like `git diff`
 * output) into the internal `PatchHunk[]` format used by `patch-applier.ts`.
 *
 * Each `@@ ... @@` hunk header is parsed for:
 *   - old-file start line number (used as a soft hint, `lineHint`)
 *   - optional section heading text (used as a soft anchor)
 *
 * Body lines are classified by their first character:
 *   ` ` → context (assigned to contextBefore/contextAfter, or interleaved inside the change zone)
 *   `-` → removal (part of oldLines / the old change zone)
 *   `+` → addition (part of newLines / the new change zone)
 *   `\` → no-newline marker (silently dropped)
 *
 * Interleaved context lines that appear between `-`/`+` lines inside the change
 * zone are preserved as part of both `oldLines` and `newLines` (in their
 * original positions), following standard unified-diff semantics. The typed
 * `changeZone` array records the kind of each line so the renderer can show
 * context lines as ` ` rather than as spurious `-`/`+` changes.
 */

import type { ChangeZoneLine, PatchHunk } from './patch-applier.js';

// ── Types ──────────────────────────────────────────────────────────────

/** Extends PatchHunk with hints extracted from the @@ hunk header */
export interface HunkWithHints extends PatchHunk {
  /** 1-based start line number from the old-file position in the @@ header */
  lineHint?: number;
  /** Section heading text after @@ ... @@ (e.g., "function foo():") */
  sectionHeading?: string;
}

// ── Regex ──────────────────────────────────────────────────────────────

/**
 * Matches a unified diff hunk header.
 *
 * Groups:
 *   1: old-start (required)
 *   2: old-count (optional, default 1)
 *   3: new-start (required)
 *   4: new-count (optional, default 1)
 *   5: section heading (everything after the second @@)
 *
 * Examples:
 *   @@ -10,4 +10,4 @@        → groups: [10,4,10,4,""]
 *   @@ -10 +12 @@             → groups: [10,undefined,12,undefined,""]
 *   @@ -5,7 +5,7 @@ def foo(): → groups: [5,7,5,7," def foo():"]
 */
const HUNK_HEADER_RE =
  /^@@[ ]+-(\d+)(?:,(\d+))?[ ]+\+(\d+)(?:,(\d+))?[ ]+@@(.*)$/;

// ── Parser ─────────────────────────────────────────────────────────────

/**
 * Parse a unified diff string into an array of hunk descriptors suitable
 * for passing to `applyPatch()`.
 *
 * @param diff - A standard unified diff string (may include leading/trailing
 *               context like `---`/`+++` file headers — those are ignored).
 * @returns Array of HunkWithHints (empty if no hunks found).
 */
export function parseUnifiedDiff(diff: string): HunkWithHints[] {
  if (!diff || !diff.trim()) return [];

  const lines = diff.split('\n');
  const hunks: HunkWithHints[] = [];
  let i = 0;

  while (i < lines.length) {
    const headerMatch = lines[i].match(HUNK_HEADER_RE);

    if (!headerMatch) {
      i++;
      continue;
    }

    // ── Extract header info ──────────────────────────────────────────
    const oldStart = parseInt(headerMatch[1], 10);
    const sectionHeading = headerMatch[5].trim();

    // ── Collect body lines until next header ─────────────────────────
    i++;
    const bodyLines: string[] = [];
    while (i < lines.length && !lines[i].match(HUNK_HEADER_RE)) {
      bodyLines.push(lines[i]);
      i++;
    }

    // ── Classify body lines ──────────────────────────────────────────
    const hunk = classifyBody(bodyLines, oldStart, sectionHeading);
    hunks.push(hunk);
  }

  return hunks;
}

// ── Body classification ────────────────────────────────────────────────

/**
 * Classify the body lines of a single hunk into contextBefore, the typed
 * changeZone, oldLines, newLines, and contextAfter.
 *
 * Lines between the first and last `-`/`+` line (inclusive) form the change
 * zone. Interleaved ` `-prefixed lines inside the change zone are preserved
 * in both oldLines and newLines (standard unified-diff semantics): the old
 * version of the change zone is what the matching engine searches for, and
 * the new version is what it replaces the matched span with.
 */
function classifyBody(
  bodyLines: string[],
  lineHint: number,
  sectionHeading: string
): HunkWithHints {
  // Find the index range of `-`/`+` lines (the "change zone")
  let firstChangeIdx = -1;
  let lastChangeIdx = -1;

  for (let i = 0; i < bodyLines.length; i++) {
    const ch = bodyLines[i][0];
    if (ch === '-' || ch === '+') {
      if (firstChangeIdx === -1) firstChangeIdx = i;
      lastChangeIdx = i;
    }
  }

  // If no changes found, all non-empty, non-marker lines are context
  if (firstChangeIdx === -1) {
    const contextBefore: string[] = [];
    for (const line of bodyLines) {
      if (line.length === 0) continue;
      if (line[0] === '\\') continue;
      contextBefore.push(line.slice(1));
    }
    return {
      anchors: sectionHeading ? [sectionHeading] : [],
      contextBefore,
      changeZone: [],
      oldLines: [],
      newLines: [],
      contextAfter: [],
      lineHint: lineHint > 0 ? lineHint : undefined,
      sectionHeading: sectionHeading || undefined,
    };
  }

  const contextBefore: string[] = [];
  const changeZone: ChangeZoneLine[] = [];
  const contextAfter: string[] = [];

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];

    // Skip completely empty lines
    if (line.length === 0) continue;

    const ch = line[0];

    // Skip no-newline markers
    if (ch === '\\') continue;

    const content = line.slice(1);

    if (i < firstChangeIdx) {
      // All lines before the first change are contextBefore
      contextBefore.push(content);
    } else if (i > lastChangeIdx) {
      // All lines after the last change are contextAfter
      contextAfter.push(content);
    } else {
      // Inside the change zone: classify by prefix
      if (ch === '-') {
        changeZone.push({ kind: '-', content });
      } else if (ch === '+') {
        changeZone.push({ kind: '+', content });
      } else {
        // Interleaved context line inside the change zone — preserved
        // in both oldLines and newLines (standard unified-diff semantics).
        changeZone.push({ kind: ' ', content });
      }
    }
  }

  // Derive flat oldLines/newLines arrays from the typed change zone.
  // oldLines = old version of the change zone = `-` lines + interleaved ` ` lines.
  // newLines = new version of the change zone = `+` lines + interleaved ` ` lines.
  const oldLines = changeZone
    .filter(l => l.kind === '-' || l.kind === ' ')
    .map(l => l.content);
  const newLines = changeZone
    .filter(l => l.kind === '+' || l.kind === ' ')
    .map(l => l.content);

  return {
    anchors: sectionHeading ? [sectionHeading] : [],
    contextBefore,
    changeZone,
    oldLines,
    newLines,
    contextAfter,
    lineHint: lineHint > 0 ? lineHint : undefined,
    sectionHeading: sectionHeading || undefined,
  };
}
