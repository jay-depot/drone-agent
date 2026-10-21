import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getEmbeddingMeta,
  insertWikiChunk,
  rebuildVecTables,
  replaceWikiPage,
  searchWikiChunksByVector,
  setEmbeddingMeta,
  upsertFile,
  insertChunk,
  getFileHash,
} from '../src/db/index.js';
import { setupDb, teardownDb } from './setup.js';

function fakeEmbedding(dimensions: number, activeIndex = 0): Float32Array {
  const v = new Float32Array(dimensions);
  v[activeIndex] = 1;
  return v;
}

describe('embedding meta', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('returns undefined when no meta row exists', () => {
    expect(getEmbeddingMeta()).toBeUndefined();
  });

  it('round-trips the embedding identity', () => {
    setEmbeddingMeta({
      modelId: 'nomic-embed-text-v1.5',
      dimensions: 768,
      backend: 'onnx',
      dtype: 'q8',
    });
    const meta = getEmbeddingMeta();
    expect(meta?.modelId).toBe('nomic-embed-text-v1.5');
    expect(meta?.dimensions).toBe(768);
    expect(meta?.backend).toBe('onnx');
    expect(meta?.dtype).toBe('q8');
    expect(meta?.updatedAt).toBeGreaterThan(0);
  });

  it('upserts a single row rather than appending', () => {
    setEmbeddingMeta({
      modelId: 'a',
      dimensions: 768,
      backend: 'onnx',
      dtype: 'q8',
    });
    setEmbeddingMeta({
      modelId: 'b',
      dimensions: 1024,
      backend: 'ollama',
      dtype: 'gguf',
    });
    expect(getEmbeddingMeta()?.modelId).toBe('b');
    expect(getEmbeddingMeta()?.dimensions).toBe(1024);
  });
});

describe('rebuildVecTables', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('accepts vectors of the new dimension', () => {
    rebuildVecTables(1024);
    insertChunk('/dir', '/dir/a.ts', 0, 'chunk', fakeEmbedding(1024));
    replaceWikiPage('p1', 'beacon', { title: 'P', updatedAt: 'u', hash: 'h' }, [
      { index: 0, text: 'wiki chunk', embedding: fakeEmbedding(1024) },
    ]);

    const hits = searchWikiChunksByVector(fakeEmbedding(1024), 5);
    expect(hits.map(hit => hit.text)).toContain('wiki chunk');
  });

  it('rejects vectors of the old dimension after a rebuild', () => {
    rebuildVecTables(1024);
    expect(() =>
      insertWikiChunk('p1', 'beacon', 0, 'x', fakeEmbedding(768))
    ).toThrow();
  });

  it('clears indexed content so a stale index cannot survive a model change', () => {
    upsertFile('/dir', '/dir/a.ts', 'hash-1');
    insertChunk('/dir', '/dir/a.ts', 0, 'chunk', fakeEmbedding(768));
    replaceWikiPage('p1', 'beacon', { title: 'P', updatedAt: 'u', hash: 'h' }, [
      { index: 0, text: 'wiki chunk', embedding: fakeEmbedding(768) },
    ]);

    rebuildVecTables(1024);

    expect(getFileHash('/dir', '/dir/a.ts')).toBeUndefined();
    expect(searchWikiChunksByVector(fakeEmbedding(1024), 5)).toHaveLength(0);
    expect(
      searchWikiChunksByVector(fakeEmbedding(1024), 5).find(
        hit => hit.pageId === 'p1'
      )
    ).toBeUndefined();
  });
});
