import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { MemoryEntry } from './types.js';

const MEMORY_DIR_NAME = 'memory';
const CONFIG_DIR_NAME = '.drone-agent';
const TMP_SUFFIX = '.tmp';

/**
 * Sanitize a memory key for use as a filename.
 *
 * Rules:
 *   - Reject keys containing `..` (directory escape)
 *   - Reject keys that start with `.` (hidden files)
 *   - Replace `/` with `__` (no subdirectories)
 *   - Replace all other path separators with `_`
 *   - Reject empty keys
 *
 * @throws {Error} if the key is invalid.
 */
export function sanitizeKey(key: string): string {
  if (!key || key.trim().length === 0) {
    throw new Error('Memory key must be a non-empty string.');
  }

  const trimmed = key.trim();

  if (trimmed.includes('..')) {
    throw new Error(
      `Memory key "${trimmed}" is invalid: ".." is not allowed.`
    );
  }

  if (trimmed.startsWith('.')) {
    throw new Error(
      `Memory key "${trimmed}" is invalid: leading "." is not allowed.`
    );
  }

  // Replace path separators with safe alternatives
  let safe = trimmed.replace(/[/\\]/g, '__');

  // Replace any remaining filesystem-unsafe characters
  safe = safe.replace(/[<>"|?*\x00-\x1f]/g, '_');

  return safe;
}

/**
 * Resolve the memory directory path for a given project directory.
 */
export function resolveMemoryDir(projectDir: string): string {
  return path.join(projectDir, CONFIG_DIR_NAME, MEMORY_DIR_NAME);
}

/**
 * Read a single memory entry from disk.
 *
 * @param memoryDir - The memory directory (from `resolveMemoryDir`).
 * @param key - The memory key (will be sanitized).
 * @returns The entry, or `null` if it does not exist.
 */
export async function readMemoryEntry(
  memoryDir: string,
  key: string
): Promise<MemoryEntry | null> {
  const safeKey = sanitizeKey(key);
  const filePath = path.join(memoryDir, `${safeKey}.json`);

  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as MemoryEntry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Write a memory entry to disk atomically.
 *
 * Writes to a `.tmp` file first, then renames to the final path. This
 * ensures that concurrent readers never see a partially written file.
 *
 * Creates the memory directory (and parents) if it does not exist.
 *
 * @param memoryDir - The memory directory (from `resolveMemoryDir`).
 * @param entry - The entry to persist. `entry.key` is used as the filename.
 */
export async function writeMemoryEntry(
  memoryDir: string,
  entry: MemoryEntry
): Promise<void> {
  const safeKey = sanitizeKey(entry.key);
  await mkdir(memoryDir, { recursive: true });

  const filePath = path.join(memoryDir, `${safeKey}.json`);
  const tmpPath = path.join(memoryDir, `${safeKey}.json${TMP_SUFFIX}`);

  const serialized = JSON.stringify(entry, null, 2);

  // Atomic write: write to temp, then rename
  await writeFile(tmpPath, serialized, 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Delete a single memory entry from disk.
 *
 * @param memoryDir - The memory directory.
 * @param key - The memory key (will be sanitized).
 * @returns `true` if the entry was removed, `false` if it did not exist.
 */
export async function deleteMemoryEntry(
  memoryDir: string,
  key: string
): Promise<boolean> {
  const safeKey = sanitizeKey(key);
  const filePath = path.join(memoryDir, `${safeKey}.json`);

  try {
    await rm(filePath, { force: false });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * List all memory entries in the directory, returning key and last-updated
 * timestamp for each. Optionally filters by key prefix.
 *
 * @param memoryDir - The memory directory.
 * @param prefix - Optional key prefix to filter by.
 */
export async function listMemoryEntries(
  memoryDir: string,
  prefix?: string
): Promise<{ key: string; updatedAt: string }[]> {
  let files: string[];
  try {
    files = await readdir(memoryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const results: { key: string; updatedAt: string }[] = [];

  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith(`${TMP_SUFFIX}`)) {
      continue;
    }

    // Extract key from filename (strip .json)
    const fileKey = file.slice(0, -5);

    // Read the entry to get the stored key (for prefix matching) and updatedAt
    const entry = await readMemoryEntry(memoryDir, fileKey);
    if (!entry) {
      continue;
    }

    if (prefix && !entry.key.startsWith(prefix)) {
      continue;
    }

    results.push({ key: entry.key, updatedAt: entry.updatedAt });
  }

  // Sort by updatedAt descending (newest first)
  results.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return results;
}

/**
 * Search memory entries by substring match against key and tags.
 *
 * @param memoryDir - The memory directory.
 * @param query - Substring to search for (case-insensitive).
 * @param limit - Maximum results (default 50).
 */
export async function searchMemoryEntries(
  memoryDir: string,
  query: string,
  limit = 50
): Promise<MemoryEntry[]> {
  const results: MemoryEntry[] = [];
  const lowerQuery = query.toLowerCase();

  let files: string[];
  try {
    files = await readdir(memoryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  for (const file of files) {
    if (!file.endsWith('.json') || file.endsWith(`${TMP_SUFFIX}`)) {
      continue;
    }

    if (results.length >= limit) {
      break;
    }

    const key = file.slice(0, -5);
    const entry = await readMemoryEntry(memoryDir, key);

    if (!entry) {
      continue;
    }

    // Match against key (already in the filename)
    if (key.toLowerCase().includes(lowerQuery)) {
      results.push(entry);
      continue;
    }

    // Match against tags
    const matchesTag = entry.tags.some(tag =>
      tag.toLowerCase().includes(lowerQuery)
    );
    if (matchesTag) {
      results.push(entry);
      continue;
    }
  }

  // Sort by updatedAt descending
  results.sort(
    (a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return results;
}

/**
 * Count the number of stored memory entries.
 */
export async function countMemoryEntries(memoryDir: string): Promise<number> {
  try {
    const files = await readdir(memoryDir);
    return files.filter(
      f => f.endsWith('.json') && !f.endsWith(`${TMP_SUFFIX}`)
    ).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

/**
 * Prune expired entries and, if `maxEntries > 0`, the oldest excess entries.
 *
 * Expired entries are those whose `ttlSeconds` has elapsed since `updatedAt`.
 *
 * @param memoryDir - The memory directory.
 * @param maxEntries - Maximum number of entries to keep (0 = unlimited).
 * @returns The number of entries removed.
 */
export async function pruneMemoryEntries(
  memoryDir: string,
  maxEntries: number
): Promise<number> {
  let files: string[];
  try {
    files = await readdir(memoryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }

  const entryFiles = files.filter(
    f => f.endsWith('.json') && !f.endsWith(`${TMP_SUFFIX}`)
  );

  const now = Date.now();
  let removed = 0;

  // Phase 1: Remove expired entries
  for (const file of entryFiles) {
    const key = file.slice(0, -5);
    const entry = await readMemoryEntry(memoryDir, key);
    if (!entry) {
      continue;
    }

    if (
      entry.ttlSeconds !== undefined &&
      entry.ttlSeconds >= 0 &&
      now - new Date(entry.updatedAt).getTime() >= entry.ttlSeconds * 1000
    ) {
      await deleteMemoryEntry(memoryDir, key);
      removed += 1;
    }
  }

  // Phase 2: If maxEntries > 0, trim excess by mtime
  if (maxEntries > 0) {
    const remaining = await listMemoryEntries(memoryDir);
    if (remaining.length > maxEntries) {
      const excess = remaining.slice(maxEntries); // oldest are at the end
      for (const entry of excess) {
        await deleteMemoryEntry(memoryDir, entry.key);
        removed += 1;
      }
    }
  }

  return removed;
}

/**
 * Create a new MemoryEntry with the given parameters.
 */
export function createMemoryEntry(
  key: string,
  value: unknown,
  tags: string[] = [],
  ttlSeconds?: number
): MemoryEntry {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    key: sanitizeKey(key),
    value,
    tags,
    createdAt: now,
    updatedAt: now,
    ttlSeconds,
  };
}

/**
 * Update an existing entry's value, tags, and updatedAt. Preserves `id` and
 * `createdAt`.
 */
export function updateMemoryEntry(
  existing: MemoryEntry,
  value: unknown,
  tags?: string[],
  ttlSeconds?: number
): MemoryEntry {
  return {
    ...existing,
    value,
    tags: tags ?? existing.tags,
    updatedAt: new Date().toISOString(),
    ttlSeconds: ttlSeconds ?? existing.ttlSeconds,
  };
}