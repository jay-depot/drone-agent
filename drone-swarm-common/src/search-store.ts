import Database from 'better-sqlite3';

// ── Types ───────────────────────────────────────────────────────────

export type SearchFileRow = {
  path: string;
  directory_path: string;
  hash: string;
  last_indexed: string;
};

export type SearchChunkRow = {
  id: number;
  directory_path: string;
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
  public readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Open the database and initialize the schema. */
  open(): void {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    if (!this.db)
      throw new Error('Database not initialized. Call open() first.');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT NOT NULL,
        directory_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        last_indexed TEXT NOT NULL,
        PRIMARY KEY (directory_path, path)
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        directory_path TEXT NOT NULL,
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(directory_path, file_path);
      CREATE INDEX IF NOT EXISTS idx_chunks_dir ON chunks(directory_path);
      CREATE INDEX IF NOT EXISTS idx_files_dir ON files(directory_path);
    `);
  }

  private assertDb(): Database.Database {
    if (!this.db)
      throw new Error('Database not initialized. Call open() first.');
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
      .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  // ── Files ────────────────────────────────────────────────────────

  getFileHash(directoryPath: string, filePath: string): string | undefined {
    const row = this.assertDb()
      .prepare('SELECT hash FROM files WHERE directory_path = ? AND path = ?')
      .get(directoryPath, filePath) as { hash: string } | undefined;
    return row?.hash;
  }

  upsertFile(directoryPath: string, filePath: string, hash: string): void {
    this.assertDb()
      .prepare(
        `INSERT OR REPLACE INTO files (path, directory_path, hash, last_indexed)
         VALUES (?, ?, ?, datetime('now'))`
      )
      .run(filePath, directoryPath, hash);
  }

  removeFile(directoryPath: string, filePath: string): void {
    this.assertDb()
      .prepare('DELETE FROM files WHERE directory_path = ? AND path = ?')
      .run(directoryPath, filePath);
  }

  getAllFilePaths(directoryPath?: string): string[] {
    if (directoryPath) {
      const rows = this.assertDb()
        .prepare('SELECT path FROM files WHERE directory_path = ?')
        .all(directoryPath) as { path: string }[];
      return rows.map(r => r.path);
    }
    const rows = this.assertDb().prepare('SELECT path FROM files').all() as {
      path: string;
    }[];
    return rows.map(r => r.path);
  }

  getFilesByDirectory(directoryPath: string): SearchFileRow[] {
    return this.assertDb()
      .prepare('SELECT * FROM files WHERE directory_path = ?')
      .all(directoryPath) as SearchFileRow[];
  }

  removeFilesByDirectory(directoryPath: string): void {
    this.assertDb()
      .prepare('DELETE FROM chunks WHERE directory_path = ?')
      .run(directoryPath);
    this.assertDb()
      .prepare('DELETE FROM files WHERE directory_path = ?')
      .run(directoryPath);
  }

  getDirectoryPaths(): string[] {
    const rows = this.assertDb()
      .prepare('SELECT DISTINCT directory_path FROM files')
      .all() as { directory_path: string }[];
    return rows.map(r => r.directory_path);
  }

  // ── Chunks ────────────────────────────────────────────────────────

  insertChunk(
    directoryPath: string,
    filePath: string,
    chunkIndex: number,
    text: string,
    embedding: Float32Array
  ): void {
    const buffer = Buffer.from(embedding.buffer);
    this.assertDb()
      .prepare(
        `INSERT INTO chunks (directory_path, file_path, chunk_index, text, embedding)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(directoryPath, filePath, chunkIndex, text, buffer);
  }

  deleteChunksForFile(directoryPath: string, filePath: string): void {
    this.assertDb()
      .prepare('DELETE FROM chunks WHERE directory_path = ? AND file_path = ?')
      .run(directoryPath, filePath);
  }

  getChunksForFile(directoryPath: string, filePath: string): SearchChunkRow[] {
    return this.assertDb()
      .prepare(
        'SELECT id, directory_path, file_path, chunk_index, text, embedding FROM chunks WHERE directory_path = ? AND file_path = ? ORDER BY chunk_index'
      )
      .all(directoryPath, filePath) as SearchChunkRow[];
  }

  getAllChunks(directoryPath?: string): SearchChunkRow[] {
    if (directoryPath) {
      return this.assertDb()
        .prepare(
          'SELECT id, directory_path, file_path, chunk_index, text, embedding FROM chunks WHERE directory_path = ? ORDER BY file_path, chunk_index'
        )
        .all(directoryPath) as SearchChunkRow[];
    }
    return this.assertDb()
      .prepare(
        'SELECT id, directory_path, file_path, chunk_index, text, embedding FROM chunks ORDER BY file_path, chunk_index'
      )
      .all() as SearchChunkRow[];
  }

  getChunkCount(directoryPath?: string): number {
    if (directoryPath) {
      const row = this.assertDb()
        .prepare(
          'SELECT COUNT(*) as count FROM chunks WHERE directory_path = ?'
        )
        .get(directoryPath) as { count: number };
      return row.count;
    }
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

  /** Remove files (and their chunks via cascade) that no longer exist on disk. */
  removeStaleFiles(
    directoryPath: string,
    existingPaths: Set<string>
  ): string[] {
    const removed: string[] = [];
    const storedPaths = this.getAllFilePaths(directoryPath);
    for (const storedPath of storedPaths) {
      if (!existingPaths.has(storedPath)) {
        this.removeFile(directoryPath, storedPath);
        removed.push(storedPath);
      }
    }
    return removed;
  }
}
