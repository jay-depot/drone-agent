import { getDatabase } from './index.js';

export interface EmbeddingMetaRow {
  model_id: string;
  dimensions: number;
  backend: string;
  dtype: string;
  updated_at: number;
}

export interface EmbeddingMeta {
  modelId: string;
  dimensions: number;
  backend: string;
  dtype: string;
  updatedAt: number;
}

export function getEmbeddingMeta(): EmbeddingMeta | undefined {
  const row = getDatabase()
    .prepare('SELECT * FROM embedding_meta WHERE id = 1')
    .get() as EmbeddingMetaRow | undefined;
  if (!row) {
    return undefined;
  }
  return {
    modelId: row.model_id,
    dimensions: row.dimensions,
    backend: row.backend,
    dtype: row.dtype,
    updatedAt: row.updated_at,
  };
}

export function setEmbeddingMeta(meta: {
  modelId: string;
  dimensions: number;
  backend: string;
  dtype: string;
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO embedding_meta (id, model_id, dimensions, backend, dtype, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         model_id = excluded.model_id,
         dimensions = excluded.dimensions,
         backend = excluded.backend,
         dtype = excluded.dtype,
         updated_at = excluded.updated_at`
    )
    .run(meta.modelId, meta.dimensions, meta.backend, meta.dtype, Date.now());
}

/**
 * Rebuild every vector table at a new dimension and clear all indexed content.
 *
 * Changing the embedding dimensions invalidates every stored vector, so the
 * whole index (workspace files and wiki pages) is discarded. The next index
 * pass repopulates it.
 */
export function rebuildVecTables(dimensions: number): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS vec_chunks;
      DROP TABLE IF EXISTS vec_chunks_bq;
      DROP TABLE IF EXISTS wiki_vec_chunks;

      CREATE VIRTUAL TABLE vec_chunks USING vec0(
        embedding FLOAT[${dimensions}] distance_metric=cosine
      );

      CREATE VIRTUAL TABLE vec_chunks_bq USING vec0(
        sig BIT[${dimensions}]
      );

      CREATE VIRTUAL TABLE wiki_vec_chunks USING vec0(
        embedding FLOAT[${dimensions}] distance_metric=cosine
      );

      DELETE FROM search_chunks;
      DELETE FROM search_files;
      DELETE FROM wiki_chunks;
      DELETE FROM wiki_sources;
    `);
  });
  tx();
}
