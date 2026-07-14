import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ── Constants ───────────────────────────────────────────────────────

const CONFIG_DIR_NAME = '.drone-agent';
const SEARCH_DB_NAME = 'search-index.db';

// ── Types ───────────────────────────────────────────────────────────

export type SearchFileRow = {
  path: string;
  hash: string;
  last_indexed: string;
};

export type SearchChunkRow = {
  id: number;
  file_path: string;
  chunk_index: number;
  text: string;
  embedding: Buffer;
};

export type SearchIndexMeta = {
  dimensions: number;
  providerId: string;
};

// ── Store ───────────────────────────────────────────────────────────

export class SearchStore {
  private db: Database.Database | null = null;
  public readonly scope: 'user' | 'project';
  public readonly dbPath: string;
  private dbDir: string;

  constructor(scope: 'user' | 'project', projectDir?: string) {
    this.scope = scope;

    if (scope === 'user') {
      this.dbDir = path.join(os.homedir(), CONFIG_DIR_NAME);
    } else if (projectDir) {
      this.dbDir = path.join(projectDir, CONFIG_DIR_NAME);
    } else {
      this.dbDir = path.join(process.cwd(), CONFIG_DIR_NAME);
    }

    this.dbPath = path.join(this.dbDir, SEARCH_DB_NAME);
  }

  /** Ensure the database directory exists and open the database. */
  async ensureDir(): Promise<void> {
    await mkdir(this.dbDir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    if (!this.db) throw new Error('Database not initialized. Call ensureDir() first.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        last_indexed TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
    `);
  }

  private assertDb(): Database.Database {
    if (!this.db) throw new Error('Database not initialized. Call ensureDir() first.');
    return this.db;
  }

  // ── Meta ─────────────────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const row = this.assertDb()
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.assertDb()
      .prepare(
        'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'
      )
      .run(key, value);
  }

  // ── Files ────────────────────────────────────────────────────────

  getFileHash(filePath: string): string | undefined {
    const row = this.assertDb()
      .prepare('SELECT hash FROM files WHERE path = ?')
      .get(filePath) as { hash: string } | undefined;
    return row?.hash;
  }

  upsertFile(filePath: string, hash: string): void {
    this.assertDb()
      .prepare(
        `INSERT OR REPLACE INTO files (path, hash, last_indexed)
         VALUES (?, ?, datetime('now'))`
      )
      .run(filePath, hash);
  }

  removeFile(filePath: string): void {
    this.assertDb().prepare('DELETE FROM files WHERE path = ?').run(filePath);
  }

  getAllFilePaths(): string[] {
    const rows = this.assertDb()
      .prepare('SELECT path FROM files')
      .all() as { path: string }[];
    return rows.map(r => r.path);
  }

  // ── Chunks ────────────────────────────────────────────────────────

  insertChunk(
    filePath: string,
    chunkIndex: number,
    text: string,
    embedding: Float32Array
  ): void {
    const buffer = Buffer.from(embedding.buffer);
    this.assertDb()
      .prepare(
        `INSERT INTO chunks (file_path, chunk_index, text, embedding)
         VALUES (?, ?, ?, ?)`
      )
      .run(filePath, chunkIndex, text, buffer);
  }

  deleteChunksForFile(filePath: string): void {
    this.assertDb().prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
  }

  getChunksForFile(filePath: string): SearchChunkRow[] {
    return this.assertDb()
      .prepare(
        'SELECT id, file_path, chunk_index, text, embedding FROM chunks WHERE file_path = ? ORDER BY chunk_index'
      )
      .all(filePath) as SearchChunkRow[];
  }

  getAllChunks(): SearchChunkRow[] {
    return this.assertDb()
      .prepare(
        'SELECT id, file_path, chunk_index, text, embedding FROM chunks ORDER BY file_path, chunk_index'
      )
      .all() as SearchChunkRow[];
  }

  getChunkCount(): number {
    const row = this.assertDb()
      .prepare('SELECT COUNT(*) as count FROM chunks')
      .get() as { count: number };
    return row.count;
  }

  // ── Transactions ──────────────────────────────────────────────────

  transaction<T>(fn: () => T): T {
    const txn = this.assertDb().transaction(fn);
    return txn();
  }

  // ── Cleanup ───────────────────────────────────────────────────────

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Remove chunks for files that no longer exist on disk. */
  removeStaleFiles(existingPaths: Set<string>): string[] {
    const removed: string[] = [];
    const storedPaths = this.getAllFilePaths();
    for (const storedPath of storedPaths) {
      if (!existingPaths.has(storedPath)) {
        this.removeFile(storedPath);
        removed.push(storedPath);
      }
    }
    return removed;
  }
}
