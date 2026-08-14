// ── Types ───────────────────────────────────────────────────────────

export type SearchResult = {
  filePath: string;
  chunkIndex: number;
  text: string;
  score: number;
};

/** A scored chunk, the input to deduplication. */
export type ScoredChunk = {
  filePath: string;
  chunkIndex: number;
  text: string;
  score: number;
};

export type DedupeOptions = {
  maxResults: number;
  /** Cap on the combined text length per file. */
  maxCombinedChars?: number;
};

// ── Deduplication ───────────────────────────────────────────────────

/**
 * Deduplicate scored chunks so each file appears at most once. For each file,
 * the entry keeps the highest-scoring chunk's `score`/`chunkIndex` for ranking,
 * but its `text` combines the text of all matching chunks. Consecutive chunks
 * are joined with a blank line; non-consecutive chunks are separated by a
 * `[...]` gap marker. The combined text is capped at `maxCombinedChars`.
 */
export function dedupeAndCombineChunks(
  scored: ScoredChunk[],
  options: DedupeOptions
): SearchResult[] {
  const { maxResults, maxCombinedChars = 8000 } = options;

  // Group by file path.
  const byFile = new Map<string, ScoredChunk[]>();
  for (const chunk of scored) {
    const list = byFile.get(chunk.filePath);
    if (list) {
      list.push(chunk);
    } else {
      byFile.set(chunk.filePath, [chunk]);
    }
  }

  const results: SearchResult[] = [];
  for (const [filePath, chunks] of byFile) {
    // Best chunk drives ranking.
    let best = chunks[0];
    for (const chunk of chunks) {
      if (chunk.score > best.score) best = chunk;
    }

    // Combine texts in chunk order, marking gaps between non-consecutive chunks.
    const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
    let combined = '';
    let prevIndex: number | null = null;
    for (const chunk of ordered) {
      if (combined.length > 0) {
        const gap =
          prevIndex !== null && chunk.chunkIndex !== prevIndex + 1
            ? '\n\n[...]\n\n'
            : '\n\n';
        combined += gap;
      }
      combined += chunk.text;
      prevIndex = chunk.chunkIndex;
    }

    if (combined.length > maxCombinedChars) {
      combined = combined.slice(0, maxCombinedChars) + '\n…';
    }

    results.push({
      filePath,
      chunkIndex: best.chunkIndex,
      text: combined,
      score: best.score,
    });
  }

  // Sort by score descending, take top results.
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}
