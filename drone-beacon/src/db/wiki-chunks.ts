import { randomUUID } from 'node:crypto';

import { getDatabase } from './index.js';

export type WikiOrigin = 'beacon' | 'coordinator';

export type PageHash = string;

export interface WikiSourceRow {
  page_id: string;
  origin: WikiOrigin;
  title: string;
  updated_at: string;
  hash: PageHash;
}

export interface WikiChunkRow {
  id: string;
  page_id: string;
  origin: WikiOrigin;
  chunk_index: number;
  text: string;
  embedding: Buffer;
}

export interface WikiSourceWithChunkCount extends WikiSourceRow {
  chunk_count: number;
}

export function listWikiSources(): WikiSourceRow[] {
  return getDatabase()
    .prepare('SELECT * FROM wiki_sources')
    .all() as WikiSourceRow[];
}

export function upsertWikiSource(
  pageId: string,
  origin: WikiOrigin,
  title: string,
  updatedAt: string,
  hash: PageHash
): void {
  getDatabase()
    .prepare(
      `INSERT INTO wiki_sources (page_id, origin, title, updated_at, hash)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(page_id, origin) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         hash = excluded.hash`
    )
    .run(pageId, origin, title, updatedAt, hash);
}

export function removeWikiSource(pageId: string, origin: WikiOrigin): void {
  deleteChunksForWikiPage(pageId, origin);
  getDatabase()
    .prepare('DELETE FROM wiki_sources WHERE page_id = ? AND origin = ?')
    .run(pageId, origin);
}

export function insertWikiChunk(
  pageId: string,
  origin: WikiOrigin,
  chunkIndex: number,
  text: string,
  embedding: Float32Array
): void {
  const id = randomUUID();
  const buffer = Buffer.from(embedding.buffer);
  const info = getDatabase()
    .prepare(
      `INSERT INTO wiki_chunks (id, page_id, origin, chunk_index, text, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, pageId, origin, chunkIndex, text, buffer);
  // Mirror the chunk into the wiki vec0 index, keyed by the source row's
  // implicit rowid. vec0 requires a genuine INTEGER rowid, so bind it as
  // BigInt (better-sqlite3 binds JS numbers as REAL).
  getDatabase()
    .prepare('INSERT INTO wiki_vec_chunks(rowid, embedding) VALUES (?, ?)')
    .run(BigInt(info.lastInsertRowid), buffer);
}

export function deleteChunksForWikiPage(
  pageId: string,
  origin: WikiOrigin
): void {
  const db = getDatabase();
  const rowids = db
    .prepare(
      'SELECT rowid FROM wiki_chunks WHERE page_id = ? AND origin = ?'
    )
    .all(pageId, origin) as { rowid: number }[];
  const delVec = db.prepare('DELETE FROM wiki_vec_chunks WHERE rowid = ?');
  for (const r of rowids) delVec.run(BigInt(r.rowid));
  db.prepare('DELETE FROM wiki_chunks WHERE page_id = ? AND origin = ?').run(
    pageId,
    origin
  );
}

export function getWikiChunks(
  pageId: string,
  origin: WikiOrigin
): WikiChunkRow[] {
  return getDatabase()
    .prepare(
      `SELECT * FROM wiki_chunks WHERE page_id = ? AND origin = ?
       ORDER BY chunk_index`
    )
    .all(pageId, origin) as WikiChunkRow[];
}

export function searchWikiChunksByVector(
  queryEmbedding: Float32Array,
  k: number
): Array<{
  pageId: string;
  origin: WikiOrigin;
  chunkIndex: number;
  text: string;
  score: number;
}> {
  const rows = getDatabase()
    .prepare(
      `SELECT c.page_id, c.origin, c.chunk_index, c.text, v.distance
       FROM wiki_vec_chunks v
       JOIN wiki_chunks c ON c.rowid = v.rowid
       WHERE v.embedding MATCH ?
       AND k = ?`
    )
    .all(Buffer.from(queryEmbedding.buffer), k) as Array<{
    page_id: string;
    origin: WikiOrigin;
    chunk_index: number;
    text: string;
    distance: number;
  }>;
  return rows.map(r => ({
    pageId: r.page_id,
    origin: r.origin,
    chunkIndex: r.chunk_index,
    text: r.text,
    score: 1 - r.distance,
  }));
}

export function replaceWikiChunks(
  pageId: string,
  origin: WikiOrigin,
  chunks: Array<{ index: number; text: string; embedding: Float32Array }>
): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    deleteChunksForWikiPage(pageId, origin);
    for (const c of chunks) {
      insertWikiChunk(pageId, origin, c.index, c.text, c.embedding);
    }
  });
  tx();
}

export function getWikiSourcesWithChunkCounts(): WikiSourceWithChunkCount[] {
  return getDatabase()
    .prepare(
      `SELECT s.*, COUNT(c.id) AS chunk_count
       FROM wiki_sources s
       LEFT JOIN wiki_chunks c ON c.page_id = s.page_id AND c.origin = s.origin
       GROUP BY s.page_id, s.origin`
    )
    .all() as WikiSourceWithChunkCount[];
}

export function backfillWikiVecChunks(): number {
  const db = getDatabase();
  const vecCount = db
    .prepare('SELECT COUNT(*) as c FROM wiki_vec_chunks')
    .get() as { c: number };
  if (vecCount.c > 0) return 0;
  const rows = db
    .prepare('SELECT rowid, embedding FROM wiki_chunks')
    .all() as { rowid: number; embedding: Buffer }[];
  if (rows.length === 0) return 0;
  const insert = db.prepare(
    'INSERT INTO wiki_vec_chunks(rowid, embedding) VALUES (?, ?)'
  );
  const tx = db.transaction((items: { rowid: number; embedding: Buffer }[]) => {
    for (const r of items) insert.run(BigInt(r.rowid), r.embedding);
  });
  tx(rows);
  return rows.length;
}