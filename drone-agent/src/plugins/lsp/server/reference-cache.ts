import path from 'node:path';
import { readDocumentSnapshot } from './helpers.js';

export type ReferenceLocation = {
  filePath: string;
  line: number;
  column: number;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  /** Trimmed line text at `line` at store time, used for staleness checks. */
  fingerprint: string;
};

export type ReferenceResolution = {
  location: ReferenceLocation;
  stale: boolean;
};

const REFERENCE_CACHE_CAP = 100;
const REFERENCE_TTL_MS = 10 * 60 * 1000;

/**
 * Reference-ID cache for destructive-edit disambiguation. Stores ambiguous
 * match locations, hands out short IDs, and resolves them later with
 * TTL + staleness (file line changed / file gone) checks. All Map/counter
 * mutations are serialized behind one lock because storeReferences' FIFO
 * eviction can evict any key; the slow disk read (freshness fingerprint)
 * happens outside the lock so unrelated references resolve concurrently.
 */
export class ReferenceCache {
  private readonly cache = new Map<
    string,
    { location: ReferenceLocation; createdAt: number }
  >();
  private counter = 0;
  private lock: Promise<void> = Promise.resolve();

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  store(locations: ReferenceLocation[]): Promise<string[]> {
    return this.withLock(async () => {
      return locations.map(location => {
        this.counter++;
        const id = `ref_${this.counter}`;
        this.cache.set(id, { location, createdAt: Date.now() });
        // FIFO eviction: Map preserves insertion order, so the first key is oldest.
        while (this.cache.size > REFERENCE_CACHE_CAP) {
          const oldestKey = this.cache.keys().next().value;
          if (oldestKey === undefined) break;
          this.cache.delete(oldestKey);
        }
        return id;
      });
    });
  }

  async resolve(
    referenceId: string,
    readFingerprint: (
      filePath: string,
      line: number
    ) => Promise<string | undefined>
  ): Promise<ReferenceResolution | undefined> {
    // Read the fingerprint outside the lock so unrelated references resolve
    // concurrently — the disk read (stat+readFile) is the slow part, and
    // serializing it behind a single session-global lock would block every
    // other reference operation. The location is immutable once stored, so
    // reading it here is safe; the entry is re-checked under the lock below.
    const entry = this.cache.get(referenceId);
    if (!entry) {
      return undefined;
    }
    const current = await readFingerprint(
      entry.location.filePath,
      entry.location.line
    );
    return this.withLock(async (): Promise<ReferenceResolution | undefined> => {
      // Re-check under the lock: a concurrent storeReferences FIFO eviction
      // may have removed the entry while we were reading the fingerprint.
      const fresh = this.cache.get(referenceId);
      if (!fresh) {
        return undefined;
      }
      // TTL expiry
      if (Date.now() - fresh.createdAt > REFERENCE_TTL_MS) {
        this.cache.delete(referenceId);
        return undefined;
      }
      // Staleness: if the file is gone or the line changed, invalidate and
      // signal the caller to re-resolve.
      if (current === undefined || current !== fresh.location.fingerprint) {
        this.cache.delete(referenceId);
        return { location: fresh.location, stale: true };
      }
      return { location: fresh.location, stale: false };
    });
  }
}

export async function readLineFingerprint(
  filePath: string,
  line: number
): Promise<string | undefined> {
  const absolutePath = path.resolve(filePath);
  let snapshot: { text: string; mtimeMs: number; size: number } | null;
  try {
    snapshot = await readDocumentSnapshot(absolutePath);
  } catch {
    return undefined;
  }
  if (!snapshot) {
    return undefined;
  }
  const lines = snapshot.text.split('\n');
  const target = lines[line - 1];
  return target === undefined ? undefined : target.trim();
}

export async function readFileSnippet(
  filePath: string,
  line: number,
  contextLines: number = 5
): Promise<string> {
  const absolutePath = path.resolve(filePath);
  let snapshot: { text: string; mtimeMs: number; size: number } | null;
  try {
    snapshot = await readDocumentSnapshot(absolutePath);
  } catch {
    return '';
  }
  if (!snapshot) {
    return '';
  }
  const lines = snapshot.text.split('\n');
  const startLine = Math.max(0, line - 1 - contextLines);
  const endLine = Math.min(lines.length, line + contextLines);
  const snippetLines = lines.slice(startLine, endLine);
  const lineNumbers = snippetLines.map((l, i) => {
    const lineNum = startLine + i + 1;
    const marker = lineNum === line ? '>' : ' ';
    return `${marker}${String(lineNum).padStart(4)} | ${l}`;
  });
  return lineNumbers.join('\n');
}
