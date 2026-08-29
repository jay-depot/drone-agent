// ── Position types ─────────────────────────────────────────────────
//
// Generic position-resolution types for tools that resolve text or
// symbol references to file positions. These are intentionally NOT
// LSP-specific — any tool that needs to disambiguate between multiple
// matches in a file (or across files) can use these types.

/** Soft context window (lines before/after) used for the `context` field. */
export const SOFT_CONTEXT_LINES = 5;
/** Hard limit for the surrounding-text suggestion search window. */
export const HARD_CONTEXT_LINES = 30;
/** How many lines to expand the search window by on each retry. */
const EXPANSION_STEP = 5;

/**
 * A single ambiguous match at a position in a file.
 */
export type AmbiguousMatch = {
  /** File containing the match. */
  filePath: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** Surrounding lines (soft context window, 5 lines before/after). */
  context: string;
  /**
   * Dense, contiguous context block (unique line + neighbors, centered on
   * the match) that would disambiguate this match from all others, or
   * `undefined` if no unique block exists within the hard context limit
   * (30 lines before/after).
   */
  suggestedContext: string | undefined;
};

/**
 * Thrown when a text or symbol lookup resolves to multiple positions and
 * the caller must disambiguate. Carries structured match data so tools
 * can present the matches to the LLM and let it pick one.
 */
export class AmbiguousPositionError extends Error {
  readonly filePath: string | undefined;
  readonly matches: AmbiguousMatch[];

  constructor(
    filePath: string | undefined,
    matches: AmbiguousMatch[],
    message: string
  ) {
    super(message);
    this.name = 'AmbiguousPositionError';
    this.filePath = filePath;
    this.matches = matches;
  }
}

/**
 * Find a minimal, contiguous context block that disambiguates a match from
 * all others. Expands the search window from the soft limit up to the hard
 * limit, 5 lines at a time. When a unique line is found at window `w`,
 * anchors on the unique line nearest the match and returns the contiguous
 * block from that line to the match line (inclusive) — the smallest block
 * that still disambiguates, since any block containing a unique line cannot
 * appear in another match's window.
 */
async function suggestContext(
  match: { filePath: string; line: number },
  allMatches: Array<{ filePath: string; line: number }>,
  getLines: (filePath: string) => Promise<string[] | undefined>
): Promise<string | undefined> {
  const lines = await getLines(match.filePath);
  if (!lines) {
    return undefined;
  }

  for (
    let window = SOFT_CONTEXT_LINES;
    window <= HARD_CONTEXT_LINES;
    window += EXPANSION_STEP
  ) {
    const start = Math.max(0, match.line - 1 - window);
    const end = Math.min(lines.length, match.line + window);
    const windowLines = lines.slice(start, end);

    const uniqueLines: Array<{ index: number }> = [];
    for (let i = 0; i < windowLines.length; i++) {
      const trimmed = windowLines[i].trim();
      if (!trimmed) {
        continue;
      }
      let isUnique = true;
      for (const other of allMatches) {
        if (other.filePath === match.filePath && other.line === match.line) {
          continue;
        }
        const otherLines = await getLines(other.filePath);
        if (!otherLines) {
          continue; // can't check, assume unique
        }
        const otherStart = Math.max(0, other.line - 1 - window);
        const otherEnd = Math.min(otherLines.length, other.line + window);
        const found = otherLines
          .slice(otherStart, otherEnd)
          .some(l => l.trim() === trimmed);
        if (found) {
          isUnique = false;
          break;
        }
      }
      if (isUnique) {
        uniqueLines.push({ index: i });
      }
    }

    if (uniqueLines.length > 0) {
      // Anchor on the unique line nearest the match and return the minimal
      // contiguous block from that line to the match line (inclusive). Any
      // block containing a unique line cannot appear in another match's
      // window, so this is guaranteed to disambiguate, and it is the smallest
      // such block.
      const matchIndex = match.line - 1 - start;
      let nearest = uniqueLines[0];
      for (const u of uniqueLines) {
        if (
          Math.abs(u.index - matchIndex) < Math.abs(nearest.index - matchIndex)
        ) {
          nearest = u;
        }
      }
      const blockStart = Math.min(nearest.index, matchIndex);
      const blockEnd = Math.max(nearest.index, matchIndex) + 1;
      return windowLines.slice(blockStart, blockEnd).join('\n');
    }
  }

  return undefined;
}

/**
 * Build `AmbiguousMatch` objects from raw position data, computing the
 * context window and suggested context block for each match.
 *
 * @param rawMatches  Raw match positions (1-based line/column).
 * @param getLines    Async function that returns the lines of a file, or
 *                    `undefined` if the file can't be read.
 */
export async function buildAmbiguousMatches(
  rawMatches: Array<{ filePath: string; line: number; column: number }>,
  getLines: (filePath: string) => Promise<string[] | undefined>
): Promise<AmbiguousMatch[]> {
  return Promise.all(
    rawMatches.map(async m => {
      const lines = await getLines(m.filePath);
      const context = lines
        ? lines
            .slice(
              Math.max(0, m.line - 1 - SOFT_CONTEXT_LINES),
              Math.min(lines.length, m.line + SOFT_CONTEXT_LINES)
            )
            .join('\n')
        : '';
      const suggested = await suggestContext(m, rawMatches, getLines);
      return {
        filePath: m.filePath,
        line: m.line,
        column: m.column,
        context,
        suggestedContext: suggested,
      };
    })
  );
}
