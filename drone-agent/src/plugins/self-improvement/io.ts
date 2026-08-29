import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Per-key promise chains that serialize operations sharing the same key. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Serialize async operations that share the same key (e.g. a file path).
 * Different keys run in parallel; only same-key operations queue up, so
 * concurrent read-modify-write cycles on the same file cannot interleave.
 */
export async function withFileLock<T>(
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  queues.set(key, run);
  try {
    return await run;
  } finally {
    if (queues.get(key) === run) queues.delete(key);
  }
}

/**
 * Write a JSON array atomically: write to a `.tmp` file then rename over the
 * target. Prevents a crash mid-write from leaving a truncated JSON file.
 */
export async function writeJsonArrayAtomic<T>(
  filePath: string,
  entries: T[]
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

/**
 * Read a JSON array from a file, returning an empty array on missing/corrupt files.
 */
export async function readJsonArray<T>(filePath: string): Promise<T[]> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

/**
 * Scan a directory for JSON files and return a summary of each.
 */
export async function scanJsonDir<T>(
  dir: string
): Promise<Array<{ id: string; entryCount: number; lastTimestamp?: string }>> {
  try {
    const entries = await readdir(dir);
    const results: Array<{
      id: string;
      entryCount: number;
      lastTimestamp?: string;
    }> = [];

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -5);
      const filePath = path.join(dir, entry);
      const data = await readJsonArray<T>(filePath);
      const lastEntry = data.length > 0 ? data[data.length - 1] : undefined;
      results.push({
        id,
        entryCount: data.length,
        lastTimestamp: (lastEntry as Record<string, unknown>)?.timestamp as
          string | undefined,
      });
    }

    return results;
  } catch {
    return [];
  }
}
