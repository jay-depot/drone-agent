import { getDatabase } from './init.js';
import { logger } from '../logger.js';
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
  getDatabase()
    .prepare('DELETE FROM search_chunks WHERE directory_path = ?')
    .run(directoryPath);
  getDatabase()
    .prepare('DELETE FROM search_files WHERE directory_path = ?')
    .run(directoryPath);
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
  getDatabase()
    .prepare(
      `INSERT INTO search_chunks (id, directory_path, file_path, chunk_index, text, embedding)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, directoryPath, filePath, chunkIndex, text, buffer);
}

export function deleteChunksForFile(
  directoryPath: string,
  filePath: string
): void {
  getDatabase()
    .prepare(
      'DELETE FROM search_chunks WHERE directory_path = ? AND file_path = ?'
    )
    .run(directoryPath, filePath);
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
