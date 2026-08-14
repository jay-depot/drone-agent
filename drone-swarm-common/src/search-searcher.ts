import type { DroneEmbeddingProvider } from 'drone-core';
import { SearchStore } from './search-store.js';

// ── Types ───────────────────────────────────────────────────────────

export type SearchResult = {
  filePath: string;
  chunkIndex: number;
  text: string;
  score: number;
};

export type SearchOptions = {
  store: SearchStore;
  provider: DroneEmbeddingProvider;
  query: string;
  maxResults: number;
  minScore?: number;
  /** Optional directory path to scope the search to. */
  directoryPath?: string;
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

// ── Cosine Similarity ───────────────────────────────────────────────

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

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

// ── Search ───────────────────────────────────────────────────────────

export async function semanticSearch(
  options: SearchOptions
): Promise<SearchResult[]> {
  const { store, provider, query, maxResults, minScore, directoryPath } =
    options;

  // Get the query embedding with search_query: prefix (per Nomic convention)
  const queryEmbedding = await provider.getEmbedding(`search_query: ${query}`);

  // Get all chunks from the store (optionally scoped to a directory)
  const allChunks = store.getAllChunks(directoryPath);

  // Compute similarity for each chunk
  const scored: ScoredChunk[] = [];

  for (const chunk of allChunks) {
    const chunkEmbedding = new Float32Array(
      chunk.embedding.buffer,
      chunk.embedding.byteOffset,
      chunk.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT
    );
    const score = cosineSimilarity(queryEmbedding, chunkEmbedding);

    if (minScore !== undefined && score < minScore) {
      continue;
    }

    scored.push({
      filePath: chunk.file_path,
      chunkIndex: chunk.chunk_index,
      text: chunk.text,
      score,
    });
  }

  return dedupeAndCombineChunks(scored, { maxResults });
}
