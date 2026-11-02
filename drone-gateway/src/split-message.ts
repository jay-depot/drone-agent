/**
 * Pure outbound message splitter for gateway service adapters.
 *
 * Splits oversized outbound text into chunks that each fit a per-service
 * character budget, preferring paragraph breaks, then line breaks, then a
 * hard cut. A hard ceiling bounds the total characters sent; beyond it the
 * tail is truncated and visibly marked.
 *
 * All lengths are UTF-16 code units (`string.length`), matching the
 * `maxMessageChars` config key.
 */

export const DEFAULT_MAX_CHUNK_CHARS = 20_000;
export const DEFAULT_MAX_TOTAL_CHARS = 100_000;

export interface SplitOptions {
  /** Source-text budget per chunk, continuation marker included. */
  maxChunkChars: number;
  /** Hard ceiling on the total characters sent across all chunks. */
  maxTotalChars: number;
  /** Suffix for continuation chunks. Default `` ` (n/m)` ``. */
  continuationMarker?: (n: number, total: number) => string;
  /**
   * Marker appended to the final message when the tail is truncated. Default
   * `` `[message truncated — N characters were dropped]` ``.
   */
  truncationMarker?: (droppedChars: number) => string;
}

const MAX_MARKER_RESERVE_ITERATIONS = 64;
const MAX_TRUNCATION_FIT_ITERATIONS = 16;

function isAllBreaks(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 10) return false;
  }
  return true;
}

/**
 * True when the chunk ending at source offset `end` would end on a markdown
 * ATX heading line (`#` to `######`). A message must not end on a heading:
 * the heading belongs to the paragraph it introduces. The line start is
 * searched backwards past earlier chunks too, so a logical line that a hard
 * cut split across chunks is judged as a whole.
 */
function endsWithHeadingLine(text: string, end: number): boolean {
  if (end <= 0) return false;
  let lineEnd = end;
  if (text.charCodeAt(lineEnd - 1) === 10) lineEnd -= 1;
  const lineStart = text.lastIndexOf('\n', lineEnd - 1) + 1;
  return /^ {0,3}#{1,6}(?:\t| |$)/.test(text.slice(lineStart, lineEnd));
}

/**
 * Split `text` into chunks ready to send.
 *
 * - Text at or under both budgets comes back as a single unmarked chunk.
 * - Otherwise chunks are packed greedily: the largest prefix ending at a
 *   paragraph break (`\n\n`), else a line break (`\n`), else a hard cut.
 *   A preferred split drops exactly one break character (so the scan window
 *   is budget + 1); a hard cut drops nothing.
 *   A break candidate that would end the message on a heading line is
 *   rejected while any later break fits; only when no valid break exists
 *   does the hard cut split (possibly mid-heading).
 * - The first message carries no marker; continuations carry
 *   `continuationMarker(n, total)`, whose length is reserved from the
 *   continuation budget. The reservation is re-packed to the smallest
 *   self-consistent chunk count, so the marker can never push a chunk over
 *   budget. (Budgets smaller than a marker width degrade to one-character
 *   chunks rather than unbounded markers.)
 * - When even the smallest marker-consistent plan exceeds `maxTotalChars`,
 *   the tail is cut and the final message ends with
 *   `truncationMarker(dropped)`. The final message carries no continuation
 *   marker — the truncation marker already says it is the end.
 */
export function splitMessage(text: string, options: SplitOptions): string[] {
  const { maxChunkChars, maxTotalChars } = options;
  if (maxChunkChars < 1) {
    throw new RangeError('maxChunkChars must be at least 1');
  }
  if (maxTotalChars < 1) {
    throw new RangeError('maxTotalChars must be at least 1');
  }
  if (text.length === 0) return [''];
  if (text.length <= maxChunkChars && text.length <= maxTotalChars) {
    return [text];
  }

  const continuationMarker =
    options.continuationMarker ?? ((n, total) => ` (${n}/${total})`);
  const truncationMarker =
    options.truncationMarker ??
    (dropped => `[message truncated — ${dropped} characters were dropped]`);

  interface PackedChunk {
    text: string;
    /** Offset of this chunk's first character in the source text. */
    start: number;
  }

  function packChunks(continuationReserve: number): PackedChunk[] {
    const chunks: PackedChunk[] = [];
    let pos = 0;
    while (pos < text.length) {
      const budget =
        chunks.length === 0
          ? maxChunkChars
          : Math.max(1, maxChunkChars - continuationReserve);
      const remaining = text.length - pos;
      if (remaining <= budget) {
        const tail = text.slice(pos);
        if (chunks.length > 0 && isAllBreaks(tail)) break;
        chunks.push({ text: tail, start: pos });
        break;
      }
      let chunkLen: number;
      let resume: number;
      let split = -1;
      const paraLimit = Math.min(budget - 1, remaining - 2);
      for (let i = paraLimit; i >= 0; i--) {
        if (
          text.charCodeAt(pos + i) === 10 &&
          text.charCodeAt(pos + i + 1) === 10 &&
          !endsWithHeadingLine(text, pos + i + 1)
        ) {
          split = i;
          break;
        }
      }
      if (split >= 0) {
        chunkLen = split + 1;
        resume = split + 2;
      } else {
        const lineLimit = Math.min(budget, remaining - 1);
        for (let i = lineLimit; i >= 0; i--) {
          if (
            text.charCodeAt(pos + i) === 10 &&
            !endsWithHeadingLine(text, pos + i)
          ) {
            split = i;
            break;
          }
        }
        if (split >= 0) {
          chunkLen = split;
          resume = split + 1;
        } else {
          chunkLen = budget;
          resume = budget;
        }
      }
      if (isAllBreaks(text.slice(pos, pos + chunkLen))) {
        // A chunk holding only line breaks carries no content; skip it so
        // the next window starts on text.
        pos += resume;
        continue;
      }
      chunks.push({ text: text.slice(pos, pos + chunkLen), start: pos });
      pos += resume;
    }
    return chunks;
  }

  // Find the smallest self-consistent chunk count: packing with a marker
  // reservation sized for `count` chunks must itself yield `count` chunks.
  // A larger reservation only shrinks chunks (more chunks), so the count
  // moves toward the fixed point from below and cannot oscillate for the
  // default monotone-width markers.
  let chunkCount = packChunks(0).length;
  let packed = packChunks(0);
  for (let i = 0; i < MAX_MARKER_RESERVE_ITERATIONS; i++) {
    const reserve = continuationMarker(chunkCount, chunkCount).length;
    packed = packChunks(reserve);
    if (packed.length === chunkCount) break;
    chunkCount = packed.length;
  }
  const packedCount = packed.length;

  /** Cost of emitting `count` full chunks (message 1 unmarked, rest marked). */
  function fullChunksCost(count: number, total: number): number {
    let cost = 0;
    for (let i = 1; i <= count; i++) {
      cost += packed[i - 1].text.length;
      if (i >= 2) cost += continuationMarker(i, total).length;
    }
    return cost;
  }

  /**
   * Fit as much of the source tail beginning at `start` as `budget` allows,
   * leaving room for the truncation marker. The marker length depends on the
   * dropped count, which depends on the cut — iterate to a fixed point.
   */
  function truncatedTail(
    start: number,
    budget: number
  ): { cut: number; dropped: number } {
    const remaining = text.length - start;
    let cut = Math.min(
      remaining,
      Math.max(0, budget - truncationMarker(remaining).length)
    );
    for (let i = 0; i < MAX_TRUNCATION_FIT_ITERATIONS; i++) {
      const next = Math.min(
        remaining,
        Math.max(0, budget - truncationMarker(remaining - cut).length)
      );
      if (next === cut) break;
      cut = next;
    }
    return { cut, dropped: remaining - cut };
  }

  // Walk the plan sizes upward. A plan of `n` messages is n-1 full chunks
  // plus a truncated tail; it is feasible when its full-chunk cost plus the
  // tail's truncation marker fits the ceiling. Both terms grow with n, so
  // the first infeasible size ends the walk.
  let bestCount = 0;
  for (let n = 1; n < packedCount; n++) {
    const fullCost = fullChunksCost(n - 1, n);
    const tailStart =
      n === 1 ? 0 : packed[n - 2].start + packed[n - 2].text.length;
    const remaining = text.length - tailStart;
    const markerLen = truncationMarker(remaining).length;
    const tailBudget = Math.min(maxChunkChars, maxTotalChars - fullCost);
    if (fullCost + markerLen > maxTotalChars || markerLen > tailBudget) {
      break;
    }
    bestCount = n;
  }

  // Sending every packed chunk (no truncation marker) is a separate plan: it
  // is preferred over any truncated plan because it drops nothing.
  if (fullChunksCost(packedCount, packedCount) <= maxTotalChars) {
    bestCount = packedCount;
  }

  const out: string[] = [];
  if (bestCount < packedCount) {
    // Truncated plan: bestCount - 1 full chunks, then the truncated tail.
    const fullCount = Math.max(0, bestCount - 1);
    for (let i = 1; i <= fullCount; i++) {
      out.push(
        packed[i - 1].text + (i >= 2 ? continuationMarker(i, bestCount) : '')
      );
    }
    const start =
      fullCount > 0
        ? packed[fullCount - 1].start + packed[fullCount - 1].text.length
        : 0;
    const budget = Math.min(
      maxChunkChars,
      maxTotalChars - fullChunksCost(fullCount, bestCount)
    );
    const tail = truncatedTail(start, budget);
    const tailText = text.slice(start, start + tail.cut);
    out.push(tailText + truncationMarker(tail.dropped));
  } else {
    for (let i = 1; i <= packedCount; i++) {
      out.push(
        packed[i - 1].text + (i >= 2 ? continuationMarker(i, packedCount) : '')
      );
    }
  }
  return out;
}
