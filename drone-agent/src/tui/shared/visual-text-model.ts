/**
 * A pure, testable module that models text as visual lines with
 * word-wrap awareness.
 *
 * This module has no React or Ink dependencies — it's pure
 * TypeScript that computes visual line positions from a string
 * and a terminal width.
 *
 * ## Word-wrap algorithm
 *
 * 1. Split text on `\n` to get logical lines.
 * 2. For each logical line, split into words (non-whitespace
 *    segments). Whitespace between words is tracked separately.
 * 3. Pack words into visual lines: if adding a word would exceed
 *    `width`, start a new visual line. Trailing whitespace at the
 *    end of a visual line is dropped (not included in the visual
 *    line's range).
 * 4. If a single word exceeds `width`, character-wrap it (split
 *    at `width` boundary).
 * 5. Continuation lines (soft-wrapped) are marked with
 *    `isContinuation: true`.
 * 6. Empty logical lines (including trailing `\n`) produce a
 *    single empty visual line so the cursor can be positioned
 *    on the empty line.
 */

/** A single visual line within the text. */
export type VisualLine = {
  /** Character offset of the first character in this visual line. */
  startOffset: number;
  /** Character offset of the first character past this visual line (exclusive). */
  endOffset: number;
  /**
   * Whether this visual line is a continuation of a soft-wrapped
   * logical line (as opposed to a hard `\n` break or the first
   * line of a logical line).
   */
  isContinuation: boolean;
};

/**
 * Compute the visual lines for `text` at the given terminal `width`.
 *
 * Returns an array of `VisualLine` objects describing where each
 * visual line starts and ends in the original text.
 */
export function computeVisualLines(text: string, width: number): VisualLine[] {
  if (width <= 0) width = 1;
  const lines: VisualLine[] = [];

  let pos = 0;
  const len = text.length;
  // Empty string produces no visual lines
  if (len === 0) return lines;

  while (pos <= len) {
    // Find the end of this logical line (next \n or end of text)
    const logicalEnd = text.indexOf('\n', pos);
    const lineEnd = logicalEnd === -1 ? len : logicalEnd;

    // Extract the logical line content (excluding the \n)
    const content = text.slice(pos, lineEnd);

    if (content.length === 0) {
      // Empty logical line — emit a single empty visual line
      lines.push({
        startOffset: pos,
        endOffset: pos,
        isContinuation: false,
      });
    } else {
      // Process the logical line with word-wrap
      processLogicalLine(content, pos, width, lines);
    }

    // Advance past the \n (or past the end)
    if (logicalEnd === -1) break;
    pos = logicalEnd + 1;
  }

  return lines;
}

/**
 * Process a single logical line (no \n characters) and add its
 * visual lines to the `lines` array.
 *
 * Words are non-whitespace segments. Whitespace between words is
 * trailing whitespace of the preceding word. When wrapping, the
 * whitespace at the end of a visual line is dropped (not included
 * in the visual line's range).
 *
 * @param content - The text of the logical line (no \n).
 * @param baseOffset - The character offset of `content` in the
 *   original text.
 * @param width - Terminal width for word-wrap.
 * @param lines - Accumulator array.
 */
function processLogicalLine(
  content: string,
  baseOffset: number,
  width: number,
  lines: VisualLine[]
): void {
  const len = content.length;
  if (len === 0) return;

  let pos = 0;
  let lineStart = 0;
  // The end of the current visual line's content (excluding trailing
  // whitespace). When we encounter a word that fits, this advances
  // to the end of that word. When we wrap, we push [lineStart, lineContentEnd).
  let lineContentEnd = 0;
  let isContinuation = false;

  while (pos < len) {
    // Skip leading whitespace at the start of a new visual line
    if (pos === lineStart) {
      while (pos < len && (content[pos] === ' ' || content[pos] === '\t')) {
        pos++;
      }
      if (pos >= len) break;
      lineStart = pos;
      lineContentEnd = pos;
    }

    // Find the next word (non-whitespace segment)
    const wordStart = pos;
    while (pos < len && content[pos] !== ' ' && content[pos] !== '\t') {
      pos++;
    }
    const wordEnd = pos;
    const wordLen = wordEnd - wordStart;

    // Find trailing whitespace after the word
    while (pos < len && (content[pos] === ' ' || content[pos] === '\t')) {
      pos++;
    }
    // pos is now at the start of the next word (or end of content)

    // ── First word on this visual line ────────────────────────────
    if (wordStart === lineStart) {
      if (wordLen > width) {
        // Character-wrap: split into chunks of `width`
        let chunkStart = wordStart;
        while (chunkStart < wordEnd) {
          const chunkEnd = Math.min(chunkStart + width, wordEnd);
          lines.push({
            startOffset: baseOffset + chunkStart,
            endOffset: baseOffset + chunkEnd,
            isContinuation: chunkStart > lineStart,
          });
          chunkStart = chunkEnd;
        }
        // Reset for next visual line
        lineStart = pos;
        lineContentEnd = pos;
        isContinuation = true;
        continue;
      }
      // First word fits on this line
      lineStart = wordStart;
      lineContentEnd = wordEnd;
      isContinuation = false;
      continue;
    }

    // ── Check if the word fits on the current visual line ──────────
    // The word starts at wordStart. The current line content ends at
    // lineContentEnd. The whitespace between lineContentEnd and wordStart
    // is included in the line if the word fits.
    const wouldEndAt = wordEnd;
    const lineLen = wouldEndAt - lineStart;
    if (lineLen <= width) {
      // Word fits — extend the current visual line
      lineContentEnd = wordEnd;
      continue;
    }

    // Word doesn't fit — close this visual line and start a new one
    lines.push({
      startOffset: baseOffset + lineStart,
      endOffset: baseOffset + lineContentEnd,
      isContinuation,
    });
    lineStart = wordStart;
    lineContentEnd = wordEnd;
    isContinuation = true;
  }

  // ── Flush remaining content on this visual line ─────────────────
  if (lineContentEnd > lineStart) {
    lines.push({
      startOffset: baseOffset + lineStart,
      endOffset: baseOffset + lineContentEnd,
      isContinuation,
    });
  }
}

/**
 * Convert a character offset to a visual (line, column) position.
 *
 * Returns `{ line, col }` where `line` is the index into the array
 * returned by `computeVisualLines`, and `col` is the column within
 * that visual line (0-based).
 *
 * If `offset` is past the end of the text, returns the position of
 * the last visual line's end.
 */
export function offsetToVisual(
  text: string,
  offset: number,
  width: number
): { line: number; col: number } {
  const lines = computeVisualLines(text, width);
  if (lines.length === 0) return { line: 0, col: 0 };

  const clamped = Math.min(offset, text.length);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (clamped >= line.startOffset && clamped <= line.endOffset) {
      return { line: i, col: clamped - line.startOffset };
    }
  }

  // Past the end — return the last position
  const last = lines[lines.length - 1];
  return {
    line: lines.length - 1,
    col: last.endOffset - last.startOffset,
  };
}

/**
 * Convert a visual (line, column) position to a character offset.
 *
 * `col` is clamped to the visual line's length. If `line` is out of
 * range, returns the start or end offset as appropriate.
 */
export function visualToOffset(
  text: string,
  line: number,
  col: number,
  width: number
): number {
  const lines = computeVisualLines(text, width);
  if (lines.length === 0) return 0;

  const clampedLine = Math.max(0, Math.min(line, lines.length - 1));
  const visualLine = lines[clampedLine];
  const lineLen = visualLine.endOffset - visualLine.startOffset;
  const clampedCol = Math.max(0, Math.min(col, lineLen));

  return visualLine.startOffset + clampedCol;
}

/**
 * Find the start of the logical line containing `offset`.
 *
 * Returns the offset of the first character after the previous `\n`,
 * or 0 if there is no previous `\n`.
 */
export function findLineStart(text: string, offset: number): number {
  const clamped = Math.min(offset, text.length);
  const prevNewline = text.lastIndexOf('\n', clamped - 1);
  return prevNewline === -1 ? 0 : prevNewline + 1;
}

/**
 * Find the end of the logical line containing `offset`.
 *
 * Returns the offset of the next `\n`, or `text.length` if there is
 * no next `\n`.
 */
export function findLineEnd(text: string, offset: number): number {
  const clamped = Math.min(offset, text.length);
  const nextNewline = text.indexOf('\n', clamped);
  return nextNewline === -1 ? text.length : nextNewline;
}

/**
 * Find the start of the word at or before `offset`.
 *
 * A word boundary is defined as the start of a non-whitespace
 * segment. If `offset` is in the middle of a word, returns the
 * start of that word. If `offset` is at the start of a word or
 * at position 0, returns `offset`. If `offset` is in whitespace,
 * returns the start of the preceding word (or 0).
 */
export function findWordStart(text: string, offset: number): number {
  const clamped = Math.min(offset, text.length);
  if (clamped <= 0) return 0;

  // If we're at a word boundary (start of non-whitespace), return it
  if (
    clamped < text.length &&
    text[clamped] !== ' ' &&
    text[clamped] !== '\t'
  ) {
    // Check if the previous char is whitespace or start of string
    if (
      clamped === 0 ||
      text[clamped - 1] === ' ' ||
      text[clamped - 1] === '\t'
    ) {
      return clamped;
    }
  }

  // If we're in whitespace, skip back to the end of the previous word
  let i = clamped - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) {
    i--;
  }

  // Now we're at the end of a word (or at -1). Skip back to the start.
  while (i >= 0 && text[i] !== ' ' && text[i] !== '\t') {
    i--;
  }

  return i + 1;
}

/**
 * Find the end of the word at or after `offset`.
 *
 * Returns the offset of the first character past the word (i.e.,
 * the start of the next whitespace or the next word). If `offset`
 * is in whitespace, returns the end of the next word. If `offset`
 * is at the end of the text, returns `text.length`.
 */
export function findWordEnd(text: string, offset: number): number {
  const clamped = Math.min(offset, text.length);
  if (clamped >= text.length) return text.length;

  // Skip any whitespace at the current position
  let i = clamped;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i++;
  }

  // Now skip the word
  while (i < text.length && text[i] !== ' ' && text[i] !== '\t') {
    i++;
  }

  return i;
}
