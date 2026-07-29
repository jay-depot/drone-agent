/**
 * Shared types for the patch-applier cascade.
 */

import type { FuzzLevel } from '../diff-renderer.js';

/** A single line inside the change zone, classified by diff prefix. */
export type ChangeZoneLineKind = ' ' | '-' | '+';

/** A typed line within the change zone (preserves diff structure for rendering). */
export interface ChangeZoneLine {
  kind: ChangeZoneLineKind;
  content: string;
}

/** A single hunk in a content-anchor-based patch */
export interface PatchHunk {
  /** Section heading used as a soft anchor (currently the sole anchor source) */
  anchors: string[];
  /** Lines expected before the change zone (context) */
  contextBefore: string[];
  /** Typed change zone: each line marked as ` `, `-`, or `+` (for rendering) */
  changeZone: ChangeZoneLine[];
  /** Old version of the change zone = `-` lines + interleaved ` ` lines (search key) */
  oldLines: string[];
  /** New version of the change zone = `+` lines + interleaved ` ` lines (replacement) */
  newLines: string[];
  /** Lines expected after the change zone (context) */
  contextAfter: string[];

  // ── Optional search hints (populated by unified-diff-parser) ─────────

  /** 1-based line number hint from @@ -start,count header — soft hint, tie-breaker */
  lineHint?: number;
  /** Section heading from @@ ... @@ heading — soft anchor used by step 3 */
  sectionHeading?: string;
}

/** A 0-based half-open span [start, end) of file lines that matched the old change zone. */
export interface MatchSpan {
  /** 0-based start line index (inclusive) */
  start: number;
  /** 0-based end line index (exclusive) */
  end: number;
  /** Fuzz level at which this match was found */
  fuzz: FuzzLevel;
}

/** Result of applying a single hunk */
export interface AppliedHunk {
  /** The anchors that were used to locate this hunk */
  anchors: string[];
  /** Fuzz level used to match this hunk */
  fuzz: FuzzLevel;
  /** 1-based line number where the hunk was applied (start of replaced span) */
  appliedAtLine: number;
  /** Index of the original hunk this corresponds to (0-based) */
  hunkIndex: number;
}

/** A single match site shown in a Type 1/3 cheat sheet */
export interface MatchSite {
  /** 1-based line number where the matched span starts */
  line: number;
  /** A few lines of surrounding file content (with original line numbers) */
  context: string[];
  /** A reworked hunk (unified diff text) that would uniquely target this site */
  reworkedHunk: string;
}

/** A single Levenshtein suggestion for a Type 2 failure */
export interface FuzzySuggestion {
  /** 1-based line number where the suggested span starts */
  line: number;
  /** Actual file content at the suggested span */
  content: string;
  /** Levenshtein edit distance (collapsed forms) */
  distance: number;
}

/** Which kind of failure a PatchError represents */
export type FailureType = 'type1' | 'type2' | 'type3';

/** Error information for a failed hunk */
export interface PatchError {
  /** Index of the hunk in the original array (0-based) */
  hunkIndex: number;
  /** Short human-readable error message */
  message: string;
  /** Detailed explanation */
  detail: string;
  /** The anchor lines that were used to search */
  anchors: string[];
  /** Which failure type this is */
  failureType: FailureType;
  /** Match sites for Type 1 / Type 3 failures (cheat sheet) */
  matchSites?: MatchSite[];
  /** Levenshtein suggestions for Type 2 failures (top 5, capped) */
  suggestions?: FuzzySuggestion[];
}

/** Overall result of applying a patch */
export interface PatchResult {
  /** Whether all hunks were applied successfully */
  success: boolean;
  /** Hunks that were successfully applied */
  appliedHunks: AppliedHunk[];
  /** Hunks that failed to apply */
  errors: PatchError[];
  /** The resulting lines after all successful hunks are applied */
  patchedLines: string[];
}

/** Result of a narrowing cascade: final survivors + last step with multiples. */
export interface NarrowResult {
  /** Final survivors after the cascade (1 → apply, >1 → next step, 0 → see lastMultiple) */
  survivors: MatchSpan[];
  /** The last level that had >1 survivors (for Type 3 unrolling). */
  lastMultiple: MatchSpan[];
}
