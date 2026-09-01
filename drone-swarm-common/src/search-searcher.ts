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

// ── Cosine Rescoring ────────────────────────────────────────────────

/**
 * Rescore candidate rows with exact cosine similarity against the query.
 *
 * Each row's `embedding` is assumed to be a raw little-endian float32 buffer
 * with NO header — exactly the BLOB format stored in the beacon's
 * `search_chunks.embedding` column. The buffer length must be a multiple of 4
 * (768 dims → 3072 bytes).
 *
 * Rows with a zero-length query or embedding get a score of 0 (the cosine of a
 * zero vector is undefined; 0 keeps the sort stable and total).
 *
 * Returns a new array sorted by score descending; every input row appears
 * exactly once (rescoring never drops rows), so `rows.length < k` from the
 * caller's prefilter stage is preserved through this function.
 */
export function rescoreByCosine<T extends { embedding: Buffer }>(
  queryEmbedding: Float32Array,
  rows: T[]
): Array<T & { score: number }> {
  let queryNorm = 0;
  for (let i = 0; i < queryEmbedding.length; i++) {
    queryNorm += queryEmbedding[i] * queryEmbedding[i];
  }
  queryNorm = Math.sqrt(queryNorm);

  const scored = rows.map(row => {
    const vec = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4
    );
    let vecNorm = 0;
    let dot = 0;
    for (let i = 0; i < vec.length; i++) {
      vecNorm += vec[i] * vec[i];
      dot += vec[i] * (queryEmbedding[i] ?? 0);
    }
    vecNorm = Math.sqrt(vecNorm);
    const score =
      queryNorm === 0 || vecNorm === 0 ? 0 : dot / (queryNorm * vecNorm);
    return { ...row, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
