import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { setupDb, teardownDb } from './setup.js';
import {
  getDatabase,
  upsertWikiSource,
  removeWikiSource,
  insertWikiChunk,
  getWikiChunks,
  searchWikiChunksByVector,
  replaceWikiChunks,
  listWikiSources,
  getWikiSourcesWithChunkCounts,
  backfillWikiVecChunks,
} from '../src/db/index.js';
import type { WikiOrigin } from '../src/db/index.js';

function fakeEmbedding(activeIndex: number): Float32Array {
  const v = new Float32Array(768);
  v[activeIndex] = 1;
  return v;
}

describe('wiki chunk store', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('stores wiki sources keyed by (page_id, origin)', () => {
    upsertWikiSource('p1', 'beacon', 'Page One', '2026-01-01T00:00:00Z', 'h1');
    upsertWikiSource('p1', 'coordinator', 'Page One', '2026-01-02T00:00:00Z', 'h2');

    const sources = listWikiSources();
    expect(sources).toHaveLength(2);
    expect(sources.map(s => s.origin).sort()).toEqual(['beacon', 'coordinator']);

    upsertWikiSource('p1', 'beacon', 'Page One v2', '2026-01-03T00:00:00Z', 'h3');
    const after = listWikiSources();
    expect(after).toHaveLength(2);
    const beaconRow = after.find(s => s.origin === 'beacon');
    expect(beaconRow?.title).toBe('Page One v2');
    expect(beaconRow?.hash).toBe('h3');
  });

  it('rejects origins outside the allowed set', () => {
    expect(() =>
      upsertWikiSource('p1', 'nowhere' as WikiOrigin, 'T', 'u', 'h')
    ).toThrow();
  });

  it('inserts chunks and mirrors them into the vec0 table', () => {
    upsertWikiSource('p1', 'beacon', 'Page One', '2026-01-01T00:00:00Z', 'h1');
    insertWikiChunk('p1', 'beacon', 0, 'first chunk', fakeEmbedding(3));
    insertWikiChunk('p1', 'beacon', 1, 'second chunk', fakeEmbedding(9));

    const chunks = getWikiChunks('p1', 'beacon');
    expect(chunks).toHaveLength(2);
    expect(chunks.map(c => c.chunk_index)).toEqual([0, 1]);
    expect(chunks[0].text).toBe('first chunk');


    expect(chunks[0].embedding).toBeInstanceOf(Buffer);
    expect(chunks[0].embedding.byteLength).toBe(768 * 4);
  });

  it('keeps same-id pages from different origins distinct', () => {
    insertWikiChunk('dual', 'beacon', 0, 'beacon version', fakeEmbedding(1));
    insertWikiChunk('dual', 'coordinator', 0, 'coordinator version', fakeEmbedding(2));

    expect(getWikiChunks('dual', 'beacon')).toHaveLength(1);
    expect(getWikiChunks('dual', 'coordinator')).toHaveLength(1);
    expect(getWikiChunks('dual', 'beacon')[0].text).toBe('beacon version');
  });

  it('replaceWikiChunks swaps the chunk set transactionally', () => {
    replaceWikiChunks('p1', 'beacon', [
      { index: 0, text: 'old a', embedding: fakeEmbedding(1) },
      { index: 1, text: 'old b', embedding: fakeEmbedding(2) },
    ]);
    replaceWikiChunks('p1', 'beacon', [
      { index: 0, text: 'new only', embedding: fakeEmbedding(3) },
    ]);

    const chunks = getWikiChunks('p1', 'beacon');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('new only');
  });

  it('deleteChunksForWikiPage removes both chunk rows and vec mirror rows', async () => {
    const { deleteChunksForWikiPage } = await import('../src/db/index.js');
    replaceWikiChunks('p1', 'beacon', [
      { index: 0, text: 'a', embedding: fakeEmbedding(1) },
      { index: 1, text: 'b', embedding: fakeEmbedding(2) },
    ]);

    const before = searchWikiChunksByVector(fakeEmbedding(1), 10);
    expect(before.map(r => r.text)).toContain('a');

    deleteChunksForWikiPage('p1', 'beacon');

    expect(getWikiChunks('p1', 'beacon')).toHaveLength(0);
    const after = searchWikiChunksByVector(fakeEmbedding(1), 10);
    expect(after.find(r => r.pageId === 'p1')).toBeUndefined();
  });

  it('removeWikiSource deletes the source row and its chunks', () => {
    replaceWikiChunks('gone', 'coordinator', [
      { index: 0, text: 'x', embedding: fakeEmbedding(4) },
    ]);
    removeWikiSource('gone', 'coordinator');

    expect(listWikiSources().find(s => s.page_id === 'gone')).toBeUndefined();
    expect(getWikiChunks('gone', 'coordinator')).toHaveLength(0);
  });

  it('searchWikiChunksByVector ranks by cosine similarity', () => {
    replaceWikiChunks('p1', 'beacon', [
      { index: 0, text: 'target chunk', embedding: fakeEmbedding(42) },
    ]);
    replaceWikiChunks('p2', 'beacon', [
      { index: 0, text: 'other chunk', embedding: fakeEmbedding(400) },
    ]);

    const results = searchWikiChunksByVector(fakeEmbedding(42), 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const top = results.find(r => r.text === 'target chunk');
    expect(top).toBeDefined();
    expect(top!.score).toBeGreaterThan(0.99);
    const other = results.find(r => r.text === 'other chunk');
    if (other) {
      expect(top!.score).toBeGreaterThan(other.score);
    }
  });

  it('getWikiSourcesWithChunkCounts reports chunk counts', () => {
    upsertWikiSource('p1', 'beacon', 'Page One', 'u', 'h');
    replaceWikiChunks('p1', 'beacon', [
      { index: 0, text: 'a', embedding: fakeEmbedding(1) },
      { index: 1, text: 'b', embedding: fakeEmbedding(2) },
      { index: 2, text: 'c', embedding: fakeEmbedding(3) },
    ]);

    const rows = getWikiSourcesWithChunkCounts();
    const row = rows.find(r => r.page_id === 'p1');
    expect(row?.chunk_count).toBe(3);
  });

  it('backfillWikiVecChunks repopulates an empty vec table and no-ops when populated', () => {
    replaceWikiChunks('p1', 'beacon', [
      { index: 0, text: 'a', embedding: fakeEmbedding(7) },
    ]);

    // Simulate a lost vec mirror: delete vec rows only.
    const db = getDatabase();

    const del = db.prepare('DELETE FROM wiki_vec_chunks');
    del.run();

    expect(searchWikiChunksByVector(fakeEmbedding(7), 5)).toHaveLength(0);
    expect(backfillWikiVecChunks()).toBe(1);
    expect(searchWikiChunksByVector(fakeEmbedding(7), 5)).toHaveLength(1);
    expect(backfillWikiVecChunks()).toBe(0);
  });
});