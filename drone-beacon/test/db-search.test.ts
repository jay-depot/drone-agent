import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  insertChunk,
  deleteChunksForFile,
  removeFilesByDirectory,
  searchChunksByVector,
  backfillVecChunks,
  getChunkCount,
  getDatabase,
} from '../src/db/index.js';

function embedding(...values: number[]): Float32Array {
  const arr = new Float32Array(768);
  values.forEach((v, i) => {
    arr[i] = v;
  });
  return arr;
}

beforeEach(async () => {
  await setupDb();
});

afterEach(async () => {
  await teardownDb();
});

describe('vec0 chunk helpers', () => {
  it('insertChunk mirrors the chunk into vec0', () => {
    insertChunk('/proj', '/proj/a.ts', 0, 'hello world', embedding(1, 0, 0));
    expect(getChunkCount('/proj')).toBe(1);
    // The vec0 table should have one row mirroring the chunk.
    const results = searchChunksByVector(embedding(1, 0, 0), 10);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('/proj/a.ts');
    expect(results[0].text).toBe('hello world');
  });

  it('searchChunksByVector returns results ordered by distance', () => {
    insertChunk('/proj', '/proj/a.ts', 0, 'cat', embedding(1, 0, 0));
    insertChunk('/proj', '/proj/b.ts', 0, 'dog', embedding(0, 1, 0));
    insertChunk('/proj', '/proj/c.ts', 0, 'car', embedding(0, 0, 1));

    const results = searchChunksByVector(embedding(1, 0, 0), 10);
    expect(results).toHaveLength(3);
    // The cat chunk (closest to query) ranks first.
    expect(results[0].filePath).toBe('/proj/a.ts');
    expect(results[0].score).toBeGreaterThan(0.9);
  });

  it('searchChunksByVector scopes to a directory', () => {
    insertChunk('/proj1', '/proj1/a.ts', 0, 'cat', embedding(1, 0, 0));
    insertChunk('/proj2', '/proj2/b.ts', 0, 'cat', embedding(1, 0, 0));

    const results = searchChunksByVector(embedding(1, 0, 0), 10, '/proj1');
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('/proj1/a.ts');
  });

  it('deleteChunksForFile cleans up vec0 rows', () => {
    insertChunk('/proj', '/proj/a.ts', 0, 'cat', embedding(1, 0, 0));
    insertChunk('/proj', '/proj/b.ts', 0, 'dog', embedding(0, 1, 0));

    deleteChunksForFile('/proj', '/proj/a.ts');
    expect(getChunkCount('/proj')).toBe(1);
    const results = searchChunksByVector(embedding(1, 0, 0), 10);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('/proj/b.ts');
  });

  it('removeFilesByDirectory cleans up vec0 rows', () => {
    insertChunk('/proj', '/proj/a.ts', 0, 'cat', embedding(1, 0, 0));
    insertChunk('/proj', '/proj/b.ts', 0, 'dog', embedding(0, 1, 0));

    removeFilesByDirectory('/proj');
    expect(getChunkCount('/proj')).toBe(0);
    expect(searchChunksByVector(embedding(1, 0, 0), 10)).toHaveLength(0);
  });

  it('backfillVecChunks copies existing chunks into vec0', () => {
    // Insert chunks directly into search_chunks (bypassing insertChunk) to
    // simulate pre-existing rows that need backfilling.
    const db = getDatabase();
    const ins = db.prepare(
      'INSERT INTO search_chunks (id, directory_path, file_path, chunk_index, text, embedding) VALUES (?, ?, ?, ?, ?, ?)'
    );
    ins.run(
      'u1',
      '/proj',
      '/proj/a.ts',
      0,
      'cat',
      Buffer.from(embedding(1, 0, 0).buffer)
    );
    ins.run(
      'u2',
      '/proj',
      '/proj/b.ts',
      0,
      'dog',
      Buffer.from(embedding(0, 1, 0).buffer)
    );

    const backfilled = backfillVecChunks();
    expect(backfilled).toBe(2);
    expect(searchChunksByVector(embedding(1, 0, 0), 10)).toHaveLength(2);
  });

  it('backfillVecChunks is a no-op when vec0 already has rows', () => {
    insertChunk('/proj', '/proj/a.ts', 0, 'cat', embedding(1, 0, 0));
    const backfilled = backfillVecChunks();
    expect(backfilled).toBe(0);
  });
});
