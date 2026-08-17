// ── Position types ─────────────────────────────────────────────────
//
// Generic position-resolution types for tools that resolve text or
// symbol references to file positions. These are intentionally NOT
// LSP-specific — any tool that needs to disambiguate between multiple
// matches in a file (or across files) can use these types.

/** Soft context window (lines before/after) used for the `context` field. */
const SOFT_CONTEXT_LINES = 5;
/** Hard limit for the surrounding-text suggestion search window. */
const HARD_CONTEXT_LINES = 30;
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
   * Minimal unique line from the context that would disambiguate this
   * match from all others, or `undefined` if no unique line exists
   * within the hard context limit (30 lines before/after).
   */
  suggestedSurroundingText: string | undefined;
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
 * Find the shortest line in a match's context window that does not appear
 * in any other match's context window. Expands the window from the soft
 * limit up to the hard limit, 5 lines at a time.
 */
async function suggestSurroundingText(
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

    const uniqueLines: string[] = [];
    for (const line of windowLines) {
      const trimmed = line.trim();
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
        uniqueLines.push(trimmed);
      }
    }

    if (uniqueLines.length > 0) {
      // Return the shortest unique line
      return uniqueLines.sort((a, b) => a.length - b.length)[0];
    }
  }

  return undefined;
}

/**
 * Build `AmbiguousMatch` objects from raw position data, computing the
 * context window and suggested surrounding text for each match.
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
      const suggested = await suggestSurroundingText(m, rawMatches, getLines);
      return {
        filePath: m.filePath,
        line: m.line,
        column: m.column,
        context,
        suggestedSurroundingText: suggested,
      };
    })
  );
}
