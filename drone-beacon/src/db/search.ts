import { getDatabase } from './init.js';
import { randomUUID } from 'node:crypto';

// ── Types ───────────────────────────────────────────────────────────

export type SearchDirectoryRow = {
  agent_id: string;
  directory_path: string;
  registered_at: number;
};

export type SearchFileRow = {
  id: string;
  directory_path: string;
  file_path: string;
  hash: string;
  last_indexed: number;
};

export type SearchChunkRow = {
  id: string;
  directory_path: string;
  file_path: string;
  chunk_index: number;
  text: string;
  embedding: Buffer;
};

// ── Search Directory Registration ───────────────────────────────────

export function registerSearchPath(
  agentId: string,
  directoryPath: string
): SearchDirectoryRow {
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    INSERT OR REPLACE INTO search_directories (agent_id, directory_path, registered_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(agentId, directoryPath, now);
  return {
    agent_id: agentId,
    directory_path: directoryPath,
    registered_at: now,
  };
}

export function unregisterSearchPath(
  agentId: string,
  directoryPath: string
): boolean {
  const stmt = getDatabase().prepare(`
    DELETE FROM search_directories WHERE agent_id = ? AND directory_path = ?
  `);
  const result = stmt.run(agentId, directoryPath);
  return result.changes > 0;
}

export function listSearchPaths(agentId: string): SearchDirectoryRow[] {
  const stmt = getDatabase().prepare(`
    SELECT * FROM search_directories WHERE agent_id = ?
  `);
  return stmt.all(agentId) as SearchDirectoryRow[];
}

export function listAllSearchPaths(): SearchDirectoryRow[] {
  const stmt = getDatabase().prepare('SELECT * FROM search_directories');
  return stmt.all() as SearchDirectoryRow[];
}

export function getAgentsForDirectory(directoryPath: string): string[] {
  const stmt = getDatabase().prepare(`
    SELECT agent_id FROM search_directories WHERE directory_path = ?
  `);
  const rows = stmt.all(directoryPath) as { agent_id: string }[];
  return rows.map(r => r.agent_id);
}

export function getAllDirectoryPaths(): string[] {
  const stmt = getDatabase().prepare(
    'SELECT DISTINCT directory_path FROM search_directories'
  );
  const rows = stmt.all() as { directory_path: string }[];
  return rows.map(r => r.directory_path);
}

export function removeAgentSearchPaths(agentId: string): number {
  const stmt = getDatabase().prepare(
    'DELETE FROM search_directories WHERE agent_id = ?'
  );
  const result = stmt.run(agentId);
  return result.changes;
}

// ── Search Files ────────────────────────────────────────────────────

export function getFileHash(
  directoryPath: string,
  filePath: string
): string | undefined {
  const row = getDatabase()
    .prepare(
      'SELECT hash FROM search_files WHERE directory_path = ? AND file_path = ?'
    )
    .get(directoryPath, filePath) as { hash: string } | undefined;
  return row?.hash;
}

export function upsertFile(
  directoryPath: string,
  filePath: string,
  hash: string
): void {
  const id = `${directoryPath}::${filePath}`;
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO search_files (id, directory_path, file_path, hash, last_indexed)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, directoryPath, filePath, hash, now);
}

export function removeFile(directoryPath: string, filePath: string): void {
  getDatabase()
    .prepare(
      'DELETE FROM search_files WHERE directory_path = ? AND file_path = ?'
    )
    .run(directoryPath, filePath);
}

export function getFilesByDirectory(directoryPath: string): SearchFileRow[] {
  return getDatabase()
    .prepare('SELECT * FROM search_files WHERE directory_path = ?')
    .all(directoryPath) as SearchFileRow[];
}

export function removeFilesByDirectory(directoryPath: string): void {
  const db = getDatabase();
  const rowids = db
    .prepare('SELECT rowid FROM search_chunks WHERE directory_path = ?')
    .all(directoryPath) as { rowid: number }[];
  const delVec = db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
  for (const r of rowids) delVec.run(BigInt(r.rowid));
  db.prepare('DELETE FROM search_chunks WHERE directory_path = ?').run(
    directoryPath
  );
  db.prepare('DELETE FROM search_files WHERE directory_path = ?').run(
    directoryPath
  );
}

export function removeStaleFiles(
  directoryPath: string,
  activePaths: Set<string>
): string[] {
  const removed: string[] = [];
  const stored = getFilesByDirectory(directoryPath);
  for (const file of stored) {
    if (!activePaths.has(file.file_path)) {
      removeFile(directoryPath, file.file_path);
      removed.push(file.file_path);
    }
  }
  return removed;
}

// ── Search Chunks ───────────────────────────────────────────────────

export function insertChunk(
  directoryPath: string,
  filePath: string,
  chunkIndex: number,
  text: string,
  embedding: Float32Array
): void {
  const id = randomUUID();
  const buffer = Buffer.from(embedding.buffer);
  const info = getDatabase()
    .prepare(
      `INSERT INTO search_chunks (id, directory_path, file_path, chunk_index, text, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, directoryPath, filePath, chunkIndex, text, buffer);
  // Mirror the chunk into the vec0 index, using the source row's implicit
  // rowid so we can join back. vec0 requires a genuine INTEGER rowid, so bind
  // it as BigInt (better-sqlite3 binds JS numbers as REAL).
  getDatabase()
    .prepare('INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)')
    .run(BigInt(info.lastInsertRowid), buffer);
}

export function deleteChunksForFile(
  directoryPath: string,
  filePath: string
): void {
  const db = getDatabase();
  const rowids = db
    .prepare(
      'SELECT rowid FROM search_chunks WHERE directory_path = ? AND file_path = ?'
    )
    .all(directoryPath, filePath) as { rowid: number }[];
  const delVec = db.prepare('DELETE FROM vec_chunks WHERE rowid = ?');
  for (const r of rowids) delVec.run(BigInt(r.rowid));
  db.prepare(
    'DELETE FROM search_chunks WHERE directory_path = ? AND file_path = ?'
  ).run(directoryPath, filePath);
}

export function searchChunksByVector(
  queryEmbedding: Float32Array,
  k: number,
  directoryPath?: string
): Array<{
  directoryPath: string;
  filePath: string;
  chunkIndex: number;
  text: string;
  score: number;
}> {
  const db = getDatabase();
  const sql = directoryPath
    ? `SELECT c.directory_path, c.file_path, c.chunk_index, c.text, v.distance
       FROM vec_chunks v
       JOIN search_chunks c ON c.rowid = v.rowid
       WHERE v.embedding MATCH ? AND c.directory_path = ?
       AND k = ?`
    : `SELECT c.directory_path, c.file_path, c.chunk_index, c.text, v.distance
       FROM vec_chunks v
       JOIN search_chunks c ON c.rowid = v.rowid
       WHERE v.embedding MATCH ?
       AND k = ?`;
  const params = directoryPath
    ? [Buffer.from(queryEmbedding.buffer), directoryPath, k]
    : [Buffer.from(queryEmbedding.buffer), k];
  const rows = db.prepare(sql).all(...params) as Array<{
    directory_path: string;
    file_path: string;
    chunk_index: number;
    text: string;
    distance: number;
  }>;
  return rows.map(r => ({
    directoryPath: r.directory_path,
    filePath: r.file_path,
    chunkIndex: r.chunk_index,
    text: r.text,
    score: 1 - r.distance,
  }));
}

export function backfillVecChunks(): number {
  const db = getDatabase();
  const vecCount = db.prepare('SELECT COUNT(*) as c FROM vec_chunks').get() as {
    c: number;
  };
  if (vecCount.c > 0) return 0;
  const rows = db
    .prepare('SELECT rowid, embedding FROM search_chunks')
    .all() as { rowid: number; embedding: Buffer }[];
  if (rows.length === 0) return 0;
  const insert = db.prepare(
    'INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)'
  );
  const tx = db.transaction((items: { rowid: number; embedding: Buffer }[]) => {
    for (const r of items) insert.run(BigInt(r.rowid), r.embedding);
  });
  tx(rows);
  return rows.length;
}

export function getAllChunks(directoryPath?: string): SearchChunkRow[] {
  if (directoryPath) {
    return getDatabase()
      .prepare(
        'SELECT * FROM search_chunks WHERE directory_path = ? ORDER BY file_path, chunk_index'
      )
      .all(directoryPath) as SearchChunkRow[];
  }
  return getDatabase()
    .prepare('SELECT * FROM search_chunks ORDER BY file_path, chunk_index')
    .all() as SearchChunkRow[];
}

export function getChunkCount(directoryPath?: string): number {
  if (directoryPath) {
    const row = getDatabase()
      .prepare(
        'SELECT COUNT(*) as count FROM search_chunks WHERE directory_path = ?'
      )
      .get(directoryPath) as { count: number };
    return row.count;
  }
  const row = getDatabase()
    .prepare('SELECT COUNT(*) as count FROM search_chunks')
    .get() as { count: number };
  return row.count;
}
