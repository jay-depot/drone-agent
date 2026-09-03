import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  insertChunk,
  deleteChunksForFile,
  removeFilesByDirectory,
  searchChunksByVector,
  searchChunksByVectorPrefiltered,
  backfillVecChunks,
  backfillBqVecChunks,
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

describe('vec_chunks_bq bit-signature mirror', () => {
  it('insertChunk mirrors the chunk signature into vec_chunks_bq', () => {
    insertChunk('/proj', '/proj/a.ts', 0, 'hello world', embedding(1, 0, 0));
    // Bit-KNN round-trip: query with the same embedding's sign signature.
    const db = getDatabase();
    const rows = db
      .prepare(
        `SELECT c.file_path
         FROM vec_chunks_bq v
         JOIN search_chunks c ON c.rowid = v.rowid
         WHERE v.sig MATCH vec_quantize_binary(?)
         AND k = 5`
      )
      .all(Buffer.from(embedding(1, 0, 0).buffer)) as Array<{
      file_path: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].file_path).toBe('/proj/a.ts');
  });

  it('deleteChunksForFile cleans up vec_chunks_bq rows', () => {
    insertChunk('/proj', '/proj/a.ts', 0, 'cat', embedding(1, 0, 0));
    insertChunk('/proj', '/proj/b.ts', 0, 'dog', embedding(0, 1, 0));

    deleteChunksForFile('/proj', '/proj/a.ts');
    const db = getDatabase();
    const count = db
      .prepare('SELECT COUNT(*) as c FROM vec_chunks_bq')
      .get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  it('removeFilesByDirectory cleans up vec_chunks_bq rows', () => {
    insertChunk('/proj', '/proj/a.ts', 0, 'cat', embedding(1, 0, 0));
    insertChunk('/proj', '/proj/b.ts', 0, 'dog', embedding(0, 1, 0));

    removeFilesByDirectory('/proj');
    const db = getDatabase();
    const count = db
      .prepare('SELECT COUNT(*) as c FROM vec_chunks_bq')
      .get() as {
      c: number;
    };
    expect(count.c).toBe(0);
  });

  it('backfillBqVecChunks copies existing chunks into vec_chunks_bq', () => {
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

    const backfilled = backfillBqVecChunks();
    expect(backfilled).toBe(2);
    const count = db
      .prepare('SELECT COUNT(*) as c FROM vec_chunks_bq')
      .get() as {
      c: number;
    };
    expect(count.c).toBe(2);
  });

  it('backfillBqVecChunks is a no-op when vec_chunks_bq already has rows', () => {
    insertChunk('/proj', '/proj/a.ts', 0, 'cat', embedding(1, 0, 0));
    const backfilled = backfillBqVecChunks();
    expect(backfilled).toBe(0);
  });
});

describe('searchChunksByVectorPrefiltered', () => {
  it('returns the same top-k ordering as searchChunksByVector (parity)', () => {
    // Seeded corpus: axis-aligned vectors give unambiguous cosine orderings.
    const corpus: Array<{
      dir: string;
      file: string;
      text: string;
      vec: Float32Array;
    }> = [
      {
        dir: '/proj',
        file: '/proj/a.ts',
        text: 'cat',
        vec: embedding(10, 0, 0),
      },
      {
        dir: '/proj',
        file: '/proj/b.ts',
        text: 'dog',
        vec: embedding(0, 9, 0),
      },
      {
        dir: '/proj',
        file: '/proj/c.ts',
        text: 'car',
        vec: embedding(0, 0, 8),
      },
      {
        dir: '/proj',
        file: '/proj/d.ts',
        text: 'cot',
        vec: embedding(6, 6, 0),
      },
      {
        dir: '/other',
        file: '/other/e.ts',
        text: 'cub',
        vec: embedding(5, 5, 5),
      },
    ];
    for (const c of corpus) {
      insertChunk(c.dir, c.file, 0, c.text, c.vec);
    }
    const queries: Float32Array[] = [
      embedding(1, 0, 0),
      embedding(0, 1, 0),
      embedding(1, 1, 1),
      embedding(2, -1, 0.5),
    ];
    for (const q of queries) {
      const floatOrder = searchChunksByVector(q, 10).map(r => r.filePath);
      const prefiltered = searchChunksByVectorPrefiltered(q, 10);
      expect(prefiltered.map(r => r.filePath)).toEqual(floatOrder);
      for (const r of prefiltered) {
        const float = searchChunksByVector(q, 10).find(
          x => x.filePath === r.filePath
        );
        expect(float).toBeDefined();
        expect(r.score).toBeCloseTo(float!.score, 5);
      }
    }
  });

  it('scopes to a directory', () => {
    insertChunk('/proj1', '/proj1/a.ts', 0, 'cat', embedding(1, 0, 0));
    insertChunk('/proj2', '/proj2/b.ts', 0, 'cat', embedding(1, 0, 0));

    const results = searchChunksByVectorPrefiltered(
      embedding(1, 0, 0),
      10,
      '/proj1'
    );
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('/proj1/a.ts');
  });

  it('returns fewer rows than k when the corpus is smaller (fallback condition)', () => {
    insertChunk('/proj', '/proj/a.ts', 0, 'cat', embedding(1, 0, 0));
    const results = searchChunksByVectorPrefiltered(embedding(1, 0, 0), 10);
    expect(results.length).toBeLessThan(10);
    expect(results).toHaveLength(1);
  });
});
