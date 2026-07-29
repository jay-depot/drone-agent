import type { DroneEmbeddingProvider } from 'drone-core';
import { SearchStore, type SearchChunkRow } from './search-store.js';

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
  const scored: Array<{ chunk: SearchChunkRow; score: number }> = [];

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

    scored.push({ chunk, score });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take top results
  const top = scored.slice(0, maxResults);

  return top.map(item => ({
    filePath: item.chunk.file_path,
    chunkIndex: item.chunk.chunk_index,
    text: item.chunk.text,
    score: item.score,
  }));
}
