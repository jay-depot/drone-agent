import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
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
    throw new Error(`Memory key "${trimmed}" is invalid: ".." is not allowed.`);
  }

  if (trimmed.startsWith('.')) {
    throw new Error(
      `Memory key "${trimmed}" is invalid: leading "." is not allowed.`
    );
  }

  // Replace path separators with safe alternatives
  let safe = trimmed.replace(/[/\\\\]/g, '__');

  // Replace any remaining filesystem-unsafe characters
  const CONTROL_RANGE = String.fromCharCode(0) + '-' + String.fromCharCode(31);
  safe = safe.replace(new RegExp('[<>"|?*' + CONTROL_RANGE + ']', 'g'), '_');

  return safe;
}

/**
 * Resolve the memory directory path for a given project directory.
 */
export function resolveMemoryDir(projectDir: string): string {
  return path.join(projectDir, CONFIG_DIR_NAME, MEMORY_DIR_NAME);
}

/**
 * Serialize a MemoryEntry to a markdown string with YAML frontmatter.
 */
function serializeEntry(entry: MemoryEntry): string {
  const tagsYaml =
    entry.tags.length > 0 ? entry.tags.map(t => `  - ${t}`).join('\n') : '  []';
  return [
    '---',
    `key: ${entry.key}`,
    'tags:',
    tagsYaml,
    `created: ${entry.createdAt}`,
    `updated: ${entry.updatedAt}`,
    '---',
    '',
    entry.value,
  ].join('\n');
}

/**
 * Parse a markdown string with YAML frontmatter into a MemoryEntry.
 *
 * Expected format:
 *   ---
 *   key: my-key
 *   tags:
 *     - tag1
 *   created: 2026-06-22T04:00:00.000Z
 *   updated: 2026-06-22T04:00:00.000Z
 *   ---
 *
 *   Body text here...
 */
function parseEntry(key: string, content: string): MemoryEntry | null {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    return null;
  }

  const rawFrontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2].trim();

  const entry: MemoryEntry = {
    key,
    value: body,
    tags: [],
    createdAt: '',
    updatedAt: '',
  };

  const lines = rawFrontmatter.split('\n');
  let inTags = false;

  for (const line of lines) {
    if (inTags) {
      const tagMatch = line.match(/^\s+-\s+(.+)$/);
      if (tagMatch) {
        entry.tags.push(tagMatch[1]);
        continue;
      }
      inTags = false;
    }

    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    const v = kvMatch[2].trim();

    if (k === 'key') {
      entry.key = v;
    } else if (k === 'created') {
      entry.createdAt = v;
    } else if (k === 'updated') {
      entry.updatedAt = v;
    } else if (k === 'tags') {
      if (v === '[]') {
        entry.tags = [];
      } else {
        inTags = true;
      }
    }
  }

  return entry;
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
  const filePath = path.join(memoryDir, `${safeKey}.md`);

  try {
    const content = await readFile(filePath, 'utf-8');
    return parseEntry(safeKey, content);
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

  const filePath = path.join(memoryDir, `${safeKey}.md`);
  const tmpPath = path.join(memoryDir, `${safeKey}.md${TMP_SUFFIX}`);

  const serialized = serializeEntry(entry);

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
  const filePath = path.join(memoryDir, `${safeKey}.md`);

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
    if (!file.endsWith('.md') || file.endsWith(`${TMP_SUFFIX}`)) {
      continue;
    }

    // Extract key from filename (strip .md)
    const fileKey = file.slice(0, -3);

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
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return results;
}

/**
 * Search memory entries by substring match against key, tags, and body text.
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
    if (!file.endsWith('.md') || file.endsWith(`${TMP_SUFFIX}`)) {
      continue;
    }

    if (results.length >= limit) {
      break;
    }

    const key = file.slice(0, -3);
    const entry = await readMemoryEntry(memoryDir, key);

    if (!entry) {
      continue;
    }

    // Match against key
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

    // Match against body text
    if (entry.value.toLowerCase().includes(lowerQuery)) {
      results.push(entry);
      continue;
    }
  }

  // Sort by updatedAt descending
  results.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  return results;
}

/**
 * Count the number of stored memory entries.
 */
export async function countMemoryEntries(memoryDir: string): Promise<number> {
  try {
    const files = await readdir(memoryDir);
    return files.filter(f => f.endsWith('.md') && !f.endsWith(`${TMP_SUFFIX}`))
      .length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

/**
 * Create a new MemoryEntry with the given parameters.
 */
export function createMemoryEntry(
  key: string,
  value: string,
  tags: string[] = []
): MemoryEntry {
  const now = new Date().toISOString();
  return {
    key: sanitizeKey(key),
    value,
    tags,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update an existing entry's value, tags, and updatedAt. Preserves
 * `createdAt`.
 */
export function updateMemoryEntry(
  existing: MemoryEntry,
  value: string,
  tags?: string[]
): MemoryEntry {
  return {
    ...existing,
    value,
    tags: tags ?? existing.tags,
    updatedAt: new Date().toISOString(),
  };
}
