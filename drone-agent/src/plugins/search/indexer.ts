import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { DroneEmbeddingProvider, DroneSearchPath } from 'drone-core';
import { SearchStore } from './store.js';

// ── Types ───────────────────────────────────────────────────────────

export type IndexerOptions = {
  store: SearchStore;
  provider: DroneEmbeddingProvider;
  directories: DroneSearchPath[];
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
};

export type IndexResult = {
  filesIndexed: number;
  filesSkipped: number;
  filesRemoved: number;
  chunksCreated: number;
};

// ── Helpers ─────────────────────────────────────────────────────────

/** Compute SHA-256 hex digest of file content. */
async function computeFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/** Split text into chunks by paragraph boundaries, respecting max tokens. */
function chunkText(text: string, maxTokens: number): string[] {
  // Rough token estimate: ~4 chars per token
  const maxChars = maxTokens * 4;

  // Split by double newlines (paragraphs)
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);

  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const paraTrimmed = para.trim();
    if (current.length > 0 && current.length + paraTrimmed.length + 2 > maxChars) {
      chunks.push(current);
      current = paraTrimmed;
    } else if (current.length === 0) {
      current = paraTrimmed;
    } else {
      current += '\n\n' + paraTrimmed;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  // If any chunk is still too long (single huge paragraph), split by sentences
  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length > maxChars) {
      const sentences = chunk.match(/[^.!?\n]+[.!?]*/g) || [chunk];
      let sentenceBuf = '';
      for (const sentence of sentences) {
        const s = sentence.trim();
        if (sentenceBuf.length + s.length + 1 > maxChars) {
          if (sentenceBuf.length > 0) result.push(sentenceBuf);
          sentenceBuf = s;
        } else if (sentenceBuf.length === 0) {
          sentenceBuf = s;
        } else {
          sentenceBuf += ' ' + s;
        }
      }
      if (sentenceBuf.length > 0) result.push(sentenceBuf);
    } else {
      result.push(chunk);
    }
  }

  return result;
}

// ── Indexer ─────────────────────────────────────────────────────────

export async function runIndexing(
  options: IndexerOptions
): Promise<IndexResult> {
  const { store, provider, directories, logger } = options;

  const result: IndexResult = {
    filesIndexed: 0,
    filesSkipped: 0,
    filesRemoved: 0,
    chunksCreated: 0,
  };

  // Collect all file paths from configured directories
  const allFiles = new Set<string>();
  for (const dirConfig of directories) {
    const absDir = path.resolve(dirConfig.path);
    try {
      await stat(absDir);
    } catch {
      logger?.warn?.(
        `Search index: configured directory does not exist: ${absDir}`
      );
      continue;
    }
    const includeHidden = dirConfig.includeHidden ?? false;
    const includeNodeModules = dirConfig.includeNodeModules ?? false;
    const exclude = dirConfig.exclude ?? [];
    await collectFiles(absDir, allFiles, 0, includeHidden, includeNodeModules, exclude);
  }

  // Remove stale files from the index
  const removed = store.removeStaleFiles(allFiles);
  result.filesRemoved = removed.length;

  // Store the provider id and dimensions in meta
  store.setMeta('providerId', provider.id);
  store.setMeta('dimensions', String(provider.dimensions));

  // Index each file
  for (const filePath of allFiles) {
    try {
      const hash = await computeFileHash(filePath);
      const storedHash = store.getFileHash(filePath);

      if (storedHash === hash) {
        result.filesSkipped++;
        continue;
      }

      // Read and chunk the file
      const content = await readFile(filePath, 'utf-8');
      const chunks = chunkText(content, provider.maxTokens);

      // Delete old chunks and update file metadata in a transaction
      store.transaction(() => {
        store.deleteChunksForFile(filePath);
        store.upsertFile(filePath, hash);
      });

      // Embed and insert chunks (outside transaction to avoid long-held locks)
      for (let i = 0; i < chunks.length; i++) {
        const prefixed = `search_document: ${chunks[i]}`;
        const embedding = await provider.getEmbedding(prefixed);
        store.insertChunk(filePath, i, chunks[i], embedding);
        result.chunksCreated++;
      }

      result.filesIndexed++;
    } catch (err) {
      logger?.warn?.(
        `Search index: failed to index ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

// ── File collection ─────────────────────────────────────────────────

/** Check if a path matches any of the exclude patterns. */
function isExcluded(fullPath: string, exclude: string[]): boolean {
  for (const pattern of exclude) {
    // Support simple glob-like patterns: if the pattern ends with /**,
    // match any path under that directory. Otherwise check if the path
    // contains the pattern as a segment.
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      if (fullPath.includes(prefix)) return true;
    } else if (fullPath.includes(pattern)) {
      return true;
    }
  }
  return false;
}

async function collectFiles(
  dir: string,
  result: Set<string>,
  depth = 0,
  includeHidden = false,
  includeNodeModules = false,
  exclude: string[] = []
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

    // Check exclude patterns before any other filtering
    if (isExcluded(fullPath, exclude)) continue;

    if (entry.isDirectory()) {
      // Skip hidden directories unless includeHidden is true
      if (!includeHidden && entry.name.startsWith('.')) {
        continue;
      }
      // Skip node_modules unless includeNodeModules is true
      if (!includeNodeModules && entry.name === 'node_modules') {
        continue;
      }
      await collectFiles(fullPath, result, depth + 1, includeHidden, includeNodeModules, exclude);
    } else if (entry.isFile()) {
      // Skip hidden files unless includeHidden is true
      if (!includeHidden && entry.name.startsWith('.')) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const binaryExts = new Set([
        '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
        '.woff', '.woff2', '.ttf', '.eot',
        '.zip', '.gz', '.tar', '.rar', '.7z',
        '.mp3', '.mp4', '.avi', '.mov', '.wav',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx',
        '.o', '.so', '.dll', '.dylib', '.exe',
        '.wasm',
      ]);
      if (!binaryExts.has(ext)) {
        result.add(fullPath);
      }
    }
  }
}
