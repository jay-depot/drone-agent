/**
 * Diff rendering utilities for producing colored (ANSI) output
 * for file.apply_diff results.
 */

import type { ChangeZoneLine } from './patch-applier/types.js';

// ANSI color codes
const ANSI = {
  reset: '\x1b[0m',
  // Foreground colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  // Background colors (for line highlighting)
  redBg: '\x1b[41m',
  greenBg: '\x1b[42m',
  // Bright variants
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightCyan: '\x1b[96m',
  brightYellow: '\x1b[93m',
} as const;

/** Fuzz level for a matched hunk */
export type FuzzLevel = 0 | 1 | 100 | 200;

/** Hunk input structure matching file.apply_diff input (V1 — line-number-based) */
export interface DiffHunk {
  startLine: number;
  oldLines: string[];
  newLines: string[];
}

/** Hunk input for the V2 apply_diff (content-anchor-based) */
export interface DiffHunkV2 {
  /** Content anchor line(s) — code that uniquely identifies the location */
  anchors: string[];
  /** Lines expected before the edit point (context) */
  contextBefore: string[];
  /** Typed change zone: each line marked as ` `, `-`, or `+`. When present,
   *  the renderer uses this to show interleaved context lines as ` ` rather
   *  than as spurious `-`/`+` changes. */
  changeZone?: ChangeZoneLine[];
  /** Lines to remove (old code, possibly including interleaved context) */
  oldLines: string[];
  /** Lines to insert (new code, possibly including interleaved context) */
  newLines: string[];
  /** Lines expected after the edit point (context) */
  contextAfter: string[];
  /** Fuzz level used to match this hunk (0 = exact, 1 = trailing whitespace,
   *  100 = all whitespace stripped, 200 = aggressive collapse incl. newlines) */
  fuzz?: FuzzLevel;
}

/** Summary statistics for the diff */
export interface DiffSummary {
  hunks: number;
  additions: number;
  deletions: number;
  /** Highest fuzz level used across all hunks */
  maxFuzz?: FuzzLevel;
}

/** Complete diff result with both plain and colored output */
export interface DiffResult {
  summary: DiffSummary;
  /** Plain text diff (uncolored, with +/- prefixes) */
  plain: string;
  /** ANSI-colored diff (for terminal display) */
  colored: string;
}

/**
 * Renders a single V1 hunk into unified diff format.
 * Returns both plain and colored versions.
 */
function renderHunk(
  hunk: DiffHunk,
  options: { useColor: boolean }
): { plain: string; colored: string } {
  const { useColor } = options;

  // Calculate hunk header (unified diff format)
  const oldCount = hunk.oldLines.length;
  const newCount = hunk.newLines.length;
  const header = `@@ -${hunk.startLine},${oldCount} +${hunk.startLine},${newCount} @@`;

  const plainLines: string[] = [];
  const coloredLines: string[] = [];

  // Add header
  if (useColor) {
    coloredLines.push(`${ANSI.cyan}${header}${ANSI.reset}`);
  } else {
    plainLines.push(header);
    coloredLines.push(header);
  }

  // Process lines: deletions first, then insertions, then context
  // We interleave them to show the diff properly
  const maxLen = Math.max(hunk.oldLines.length, hunk.newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = hunk.oldLines[i];
    const newLine = hunk.newLines[i];

    if (oldLine !== undefined && newLine === undefined) {
      // Deletion
      const prefix = '-';
      plainLines.push(`${prefix}${oldLine}`);
      coloredLines.push(`${ANSI.red}${prefix}${oldLine}${ANSI.reset}`);
    } else if (oldLine === undefined && newLine !== undefined) {
      // Insertion
      const prefix = '+';
      plainLines.push(`${prefix}${newLine}`);
      coloredLines.push(`${ANSI.green}${prefix}${newLine}${ANSI.reset}`);
    } else if (oldLine !== undefined && newLine !== undefined) {
      // Context (unchanged) - show both old and new if they differ
      if (oldLine === newLine) {
        const prefix = ' ';
        plainLines.push(`${prefix}${oldLine}`);
        coloredLines.push(`${prefix}${oldLine}`);
      } else {
        // Modified line: show as deletion then insertion
        const delPrefix = '-';
        const addPrefix = '+';
        plainLines.push(`${delPrefix}${oldLine}`);
        plainLines.push(`${addPrefix}${newLine}`);
        coloredLines.push(`${ANSI.red}${delPrefix}${oldLine}${ANSI.reset}`);
        coloredLines.push(`${ANSI.green}${addPrefix}${newLine}${ANSI.reset}`);
      }
    }
  }

  return {
    plain: plainLines.join('\n'),
    colored: coloredLines.join('\n'),
  };
}

/**
 * Renders a single V2 hunk into unified diff format, including fuzz info.
 * When `changeZone` is present, interleaved context lines inside the change
 * zone are rendered as ` ` (context); otherwise the hunk is rendered as
 * deletions-then-insertions (legacy behavior).
 * Returns both plain and colored versions.
 */
function renderHunkV2(
  hunk: DiffHunkV2,
  options: { useColor: boolean }
): { plain: string; colored: string } {
  const { useColor } = options;

  // Count actual additions/deletions (excluding interleaved context) for
  // the @@ header. When changeZone is present, use it; otherwise fall back
  // to oldLines/newLines lengths (which over-count if interleaved context
  // is present, but that's the legacy path).
  let oldCount: number;
  let newCount: number;
  if (hunk.changeZone && hunk.changeZone.length > 0) {
    oldCount = hunk.changeZone.filter(l => l.kind !== '+').length;
    newCount = hunk.changeZone.filter(l => l.kind !== '-').length;
  } else {
    oldCount = hunk.oldLines.length;
    newCount = hunk.newLines.length;
  }

  const anchorStr =
    hunk.anchors.length > 0 ? ` ${hunk.anchors.join(' > ')}` : '';
  const fuzzStr = hunk.fuzz !== undefined ? ` (fuzz: ${hunk.fuzz})` : '';
  const header = `@@${anchorStr} @@ -${oldCount} +${newCount}${fuzzStr}`;

  const plainLines: string[] = [];
  const coloredLines: string[] = [];

  // Add header
  if (useColor) {
    coloredLines.push(`${ANSI.cyan}${header}${ANSI.reset}`);
  } else {
    plainLines.push(header);
    coloredLines.push(header);
  }

  // Render context before
  for (const line of hunk.contextBefore) {
    plainLines.push(` ${line}`);
    coloredLines.push(` ${line}`);
  }

  // Render the change zone. When present, iterate the typed lines so
  // interleaved context is shown as ` ` (context), removals as `-`, and
  // additions as `+` in their original order. Otherwise fall back to
  // rendering all oldLines as `-` then all newLines as `+`.
  if (hunk.changeZone && hunk.changeZone.length > 0) {
    for (const zl of hunk.changeZone) {
      if (zl.kind === '-') {
        plainLines.push(`-${zl.content}`);
        coloredLines.push(`${ANSI.red}-${zl.content}${ANSI.reset}`);
      } else if (zl.kind === '+') {
        plainLines.push(`+${zl.content}`);
        coloredLines.push(`${ANSI.green}+${zl.content}${ANSI.reset}`);
      } else {
        plainLines.push(` ${zl.content}`);
        coloredLines.push(` ${zl.content}`);
      }
    }
  } else {
    for (const line of hunk.oldLines) {
      plainLines.push(`-${line}`);
      coloredLines.push(`${ANSI.red}-${line}${ANSI.reset}`);
    }
    for (const line of hunk.newLines) {
      plainLines.push(`+${line}`);
      coloredLines.push(`${ANSI.green}+${line}${ANSI.reset}`);
    }
  }

  // Render context after
  for (const line of hunk.contextAfter) {
    plainLines.push(` ${line}`);
    coloredLines.push(` ${line}`);
  }

  return {
    plain: plainLines.join('\n'),
    colored: coloredLines.join('\n'),
  };
}

/**
 * Renders a complete diff from an array of V1 hunks.
 *
 * @param filePath - Absolute path to the file that was modified
 * @param hunks - Array of hunks to render
 * @param useColor - Whether to include ANSI color codes (default: true)
 */
export function renderDiff(
  filePath: string,
  hunks: DiffHunk[],
  useColor: boolean = true
): DiffResult {
  if (hunks.length === 0) {
    return {
      summary: { hunks: 0, additions: 0, deletions: 0 },
      plain: '',
      colored: '',
    };
  }

  // Calculate summary
  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    deletions += hunk.oldLines.length;
    additions += hunk.newLines.length;
  }

  const summary: DiffSummary = {
    hunks: hunks.length,
    additions,
    deletions,
  };

  // Render each hunk
  const plainParts: string[] = [];
  const coloredParts: string[] = [];

  for (const hunk of hunks) {
    const { plain, colored } = renderHunk(hunk, { useColor });
    plainParts.push(plain);
    coloredParts.push(colored);
  }

  // Build file header
  const fileHeader = `--- ${filePath}\n+++ ${filePath}`;

  return {
    summary,
    plain: fileHeader + '\n' + plainParts.join('\n'),
    colored: useColor
      ? `${ANSI.yellow}${fileHeader}${ANSI.reset}\n${coloredParts.join('\n')}`
      : fileHeader + '\n' + plainParts.join('\n'),
  };
}

/**
 * Count actual additions/deletions in a V2 hunk, excluding interleaved
 * context lines (which appear in both oldLines and newLines).
 */
function countChanges(hunk: DiffHunkV2): {
  additions: number;
  deletions: number;
} {
  if (hunk.changeZone && hunk.changeZone.length > 0) {
    return {
      deletions: hunk.changeZone.filter(l => l.kind === '-').length,
      additions: hunk.changeZone.filter(l => l.kind === '+').length,
    };
  }
  return {
    deletions: hunk.oldLines.length,
    additions: hunk.newLines.length,
  };
}

/**
 * Renders a complete diff from an array of V2 (content-anchor-based) hunks.
 *
 * @param filePath - Absolute path to the file that was modified
 * @param hunks - Array of V2 hunks to render
 * @param useColor - Whether to include ANSI color codes (default: true)
 */
export function renderDiffV2(
  filePath: string,
  hunks: DiffHunkV2[],
  useColor: boolean = true
): DiffResult {
  if (hunks.length === 0) {
    return {
      summary: { hunks: 0, additions: 0, deletions: 0 },
      plain: '',
      colored: '',
    };
  }

  // Calculate summary
  let additions = 0;
  let deletions = 0;
  let maxFuzz: FuzzLevel = 0;

  for (const hunk of hunks) {
    const { additions: a, deletions: d } = countChanges(hunk);
    additions += a;
    deletions += d;
    if (hunk.fuzz !== undefined && hunk.fuzz > maxFuzz) {
      maxFuzz = hunk.fuzz;
    }
  }

  const summary: DiffSummary = {
    hunks: hunks.length,
    additions,
    deletions,
    maxFuzz: maxFuzz > 0 ? maxFuzz : undefined,
  };

  // Render each hunk
  const plainParts: string[] = [];
  const coloredParts: string[] = [];

  for (const hunk of hunks) {
    const { plain, colored } = renderHunkV2(hunk, { useColor });
    plainParts.push(plain);
    coloredParts.push(colored);
  }

  // Build file header
  const fileHeader = `--- ${filePath}\n+++ ${filePath}`;

  return {
    summary,
    plain: fileHeader + '\n' + plainParts.join('\n'),
    colored: useColor
      ? `${ANSI.yellow}${fileHeader}${ANSI.reset}\n${coloredParts.join('\n')}`
      : fileHeader + '\n' + plainParts.join('\n'),
  };
}

/**
 * Strips ANSI color codes from a string.
 * Useful for outputting plain text when color is not supported.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Checks if the current environment supports color output.
 * Checks for common environment variables that indicate color support.
 */
export function supportsColor(): boolean {
  // Check common environment variables
  const term = process.env.TERM?.toLowerCase() ?? '';
  const noColor = process.env.NO_COLOR;
  const forceColor = process.env.FORCE_COLOR;

  // Explicitly disabled
  if (noColor !== undefined && noColor !== '') {
    return false;
  }

  // Explicitly enabled
  if (forceColor !== undefined && forceColor !== '') {
    return true;
  }

  // Terminal type suggests color support (common terminals known to support color)
  const knownTerminals = [
    'xterm',
    'screen',
    'tmux',
    'vt100',
    'vt220',
    'rxvt',
    'ansi',
    'cygwin',
    'linux',
    'alacritty',
    'kitty',
    'wezterm',
    'ios',
  ];
  if (
    term.includes('color') ||
    term.includes('256') ||
    term === 'xterm' ||
    knownTerminals.some(t => term.includes(t))
  ) {
    return true;
  }

  // Check if stdout is a TTY (not perfect but common check)
  if (process.stdout.isTTY === true) {
    return true;
  }

  // CI environments often support color
  if (process.env.CI !== undefined) {
    return true;
  }

  return false;
}
