import path from 'node:path';

/**
 * Per-key promise chains that serialize operations sharing the same key.
 * Different keys run in parallel; only same-key operations queue up, so
 * concurrent read-modify-write cycles on the same resource cannot interleave.
 */
const queues = new Map<string, Promise<unknown>>();

/**
 * Serialize async operations that share the same key (e.g. a file path).
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
 * Serialize async operations that share the same file, keyed by the resolved
 * absolute path, lower-cased so case-variant spellings collapse on
 * case-insensitive filesystems. On case-sensitive filesystems this only
 * over-serializes the rare pair of paths that differ solely by case — it can
 * lose parallelism, never correctness.
 */
export function withPathLock<T>(
  filePath: string,
  task: () => Promise<T>
): Promise<T> {
  return withFileLock(path.resolve(filePath).toLowerCase(), task);
}
