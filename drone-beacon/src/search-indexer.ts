import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { DroneEmbeddingProvider } from 'drone-core';
import type { IndexResult } from 'drone-core';
import { chunkFile } from './file-chunker.js';
import { logger } from './logger.js';
import * as db from './db/index.js';

// ── SearchIndexer ───────────────────────────────────────────────────

// Opinionated chunk-size target (tokens). The chunker treats this as a bias,
// not a hard limit: it merges small units up to 0.5× and splits oversized
// units above 2×, keeping everything in between whole.
const CHUNK_TARGET_TOKENS = 480;

export class SearchIndexer {
  private provider: DroneEmbeddingProvider | null;
  private fingerprint: string;
  private indexing: Set<string> = new Set();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepIntervalMs: number;

  constructor(
    provider?: DroneEmbeddingProvider,
    sweepIntervalMs: number = 5 * 60 * 1000,
    fingerprint: string = ''
  ) {
    this.provider = provider ?? null;
    this.sweepIntervalMs = sweepIntervalMs;
    this.fingerprint = fingerprint;
  }

  setProvider(provider: DroneEmbeddingProvider): void {
    this.provider = provider;
  }

  getProvider(): DroneEmbeddingProvider | null {
    return this.provider;
  }

  // ── Indexing ─────────────────────────────────────────────────────

  /**
   * Index a directory. Deduplicates: if already indexing, returns immediately.
   * If another agent already indexed this directory, reuses the existing index.
   */
  async indexDirectory(dirPath: string): Promise<IndexResult> {
    const absDir = path.resolve(dirPath);

    if (this.indexing.has(absDir)) {
      logger.info(`Search index: already indexing ${absDir}, skipping`);
      return {
        filesIndexed: 0,
        filesSkipped: 0,
        filesRemoved: 0,
        chunksCreated: 0,
      };
    }

    const provider = this.provider;
    if (!provider) {
      logger.warn(
        'Search index: no embedding provider available, skipping indexing'
      );
      return {
        filesIndexed: 0,
        filesSkipped: 0,
        filesRemoved: 0,
        chunksCreated: 0,
      };
    }

    this.indexing.add(absDir);
    const result: IndexResult = {
      filesIndexed: 0,
      filesSkipped: 0,
      filesRemoved: 0,
      chunksCreated: 0,
    };

    try {
      // Verify directory exists
      try {
        await stat(absDir);
      } catch {
        logger.warn(`Search index: directory does not exist: ${absDir}`);
        return result;
      }

      // Collect all files
      const allFiles = new Set<string>();
      await collectFiles(absDir, allFiles, 0);

      // Remove stale files
      const removed = db.removeStaleFiles(absDir, allFiles);
      result.filesRemoved = removed.length;

      // Index each file
      for (const filePath of allFiles) {
        try {
          const hash = await computeFileHash(filePath, this.fingerprint);
          const storedHash = db.getFileHash(absDir, filePath);

          if (storedHash === hash) {
            result.filesSkipped++;
            continue;
          }

          // Read and chunk the file
          const content = await readFile(filePath, 'utf-8');
          const chunks = await chunkFile(
            filePath,
            content,
            Math.min(CHUNK_TARGET_TOKENS, provider.maxTokens)
          );

          // Embed every chunk first. A throw here must leave no file hash and
          // no chunks behind, so a failed file is retried on the next pass
          // instead of being recorded as indexed.
          const embeddings: Float32Array[] = [];
          for (let i = 0; i < chunks.length; i++) {
            embeddings.push(await provider.embedDocument(chunks[i]));
          }

          // One transaction: drop the old chunks, insert the new ones, and
          // record the hash.
          db.replaceFileChunks(
            absDir,
            filePath,
            hash,
            chunks.map((text, index) => ({ index, text, embedding: embeddings[index] }))
          );
          result.chunksCreated += chunks.length;

          result.filesIndexed++;
        } catch (err) {
          logger.warn(
            `Search index: failed to index ${filePath}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    } finally {
      this.indexing.delete(absDir);
    }

    logger.info(
      `Search index: indexed ${absDir} — ${result.filesIndexed} indexed, ${result.filesSkipped} skipped, ${result.filesRemoved} removed, ${result.chunksCreated} chunks`
    );
    return result;
  }

  /**
   * Remove all indexed data for a directory.
   */
  async removeDirectory(dirPath: string): Promise<void> {
    const absDir = path.resolve(dirPath);
    db.removeFilesByDirectory(absDir);
    logger.info(`Search index: removed index for ${absDir}`);
  }

  /**
   * Get list of currently indexed directory paths.
   */
  getIndexedDirectories(): string[] {
    return db.getAllDirectoryPaths();
  }

  // ── Periodic Sweep ───────────────────────────────────────────────

  /**
   * Start the periodic hash sweep. Walks all indexed directories and
   * reindexes files whose hash doesn't match the stored hash.
   */
  startPeriodicSweep(): void {
    if (this.sweepTimer) return;
    logger.info(
      `Search index: starting periodic sweep every ${this.sweepIntervalMs / 1000}s`
    );
    this.sweepTimer = setInterval(() => {
      this.runSweep().catch(err => {
        logger.error(err, 'Search index: periodic sweep failed');
      });
    }, this.sweepIntervalMs);
  }

  stopPeriodicSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private async runSweep(): Promise<void> {
    const dirs = db.getAllDirectoryPaths();
    if (dirs.length === 0) return;
    logger.info(
      `Search index: running periodic sweep on ${dirs.length} directories`
    );
    for (const dir of dirs) {
      try {
        await this.indexDirectory(dir);
      } catch (err) {
        logger.warn(
          `Search index: sweep failed for ${dir}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}

// ── File helpers ───────────────────────────────────────────────────

async function computeFileHash(
  filePath: string,
  fingerprint: string
): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256')
    .update(fingerprint)
    .update('\u0000')
    .update(content)
    .digest('hex');
}

// Never index these directories, regardless of any include flag.
const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules']);

export async function collectFiles(
  dir: string,
  result: Set<string>,
  depth = 0
): Promise<void> {
  if (depth > 20) return;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (ALWAYS_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }
      await collectFiles(fullPath, result, depth + 1);
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.')) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const binaryExts = new Set([
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.bmp',
        '.ico',
        '.svg',
        '.woff',
        '.woff2',
        '.ttf',
        '.eot',
        '.zip',
        '.gz',
        '.tar',
        '.rar',
        '.7z',
        '.mp3',
        '.mp4',
        '.avi',
        '.mov',
        '.wav',
        '.pdf',
        '.doc',
        '.docx',
        '.xls',
        '.xlsx',
        '.o',
        '.so',
        '.dll',
        '.dylib',
        '.exe',
        '.wasm',
      ]);
      if (!binaryExts.has(ext)) {
        result.add(fullPath);
      }
    }
  }
}
