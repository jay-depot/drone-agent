import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

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
          | string
          | undefined,
      });
    }

    return results;
  } catch {
    return [];
  }
}
