import { mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './logger.js';

/**
 * Coordinator-side storage for extension front-end bundles. Files land under
 * `<coordinatorDataDir>/extension-bundles/<nodeId>/<hash>/<fileName>` and are
 * served same-origin by the web port. A DB row (extension_bundles) records the
 * directory + metadata for listing and serving.
 */

let bundleRoot: string | null = null;

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_FILE = /^[A-Za-z0-9._-]+$/;
const MAX_BUNDLE_SEGMENT_LENGTH = 255;

/** Whether `id` is safe to use as a nodeId path segment (chars + length). */
export function isSafeId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= MAX_BUNDLE_SEGMENT_LENGTH &&
    SAFE_ID.test(id)
  );
}

/**
 * Sanity-check one request-supplied path segment before it is joined into a
 * filesystem path. Filters directory-traversal characters (`/`, `\`, NUL,
 * `..`), rejects dot-only/empty/over-long segments, and requires a
 * conservative character class. Shared by the write (upload) and read (serve)
 * paths.
 */
export function isSafeBundleSegment(segment: string): boolean {
  return (
    typeof segment === 'string' &&
    segment.length > 0 &&
    segment.length <= MAX_BUNDLE_SEGMENT_LENGTH &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0') &&
    !segment.includes('..') &&
    SAFE_FILE.test(segment)
  );
}

export async function initExtensionBundleStorage(
  baseDir: string
): Promise<void> {
  bundleRoot = path.join(baseDir, 'extension-bundles');
  await mkdir(bundleRoot, { recursive: true });
  logger.info(`Extension bundle storage initialized at: ${bundleRoot}`);
}

/** The absolute bundle-root directory (throws if storage is uninitialized). */
export function getBundleRoot(): string {
  if (!bundleRoot) {
    throw new Error('Extension bundle storage not initialized');
  }
  return bundleRoot;
}

export interface BundleFile {
  name: string;
  contentBase64: string;
  contentType?: string;
}

/** sha256 over the concatenated (name, bytes) pairs. */
export function computeBundleHash(files: BundleFile[]): string {
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    hash.update(f.name);
    hash.update(Buffer.from(f.contentBase64, 'base64'));
  }
  return hash.digest('hex');
}

/**
 * Write a bundle's files to disk under `<root>/<nodeId>/<hash>/`. Returns the
 * bundle directory. Rejects any file name that is not path-safe.
 */
export async function writeBundleFiles(
  nodeId: string,
  hash: string,
  files: BundleFile[]
): Promise<string> {
  if (!isSafeId(nodeId)) throw new Error('Invalid nodeId');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid hash');
  const dir = path.join(getBundleRoot(), nodeId, hash);
  // nodeId is isSafeId-validated ([a-zA-Z0-9_-], length-bounded) and hash is
  // 64 lowercase hex chars, so dir stays inside the server-controlled root.
  // codeql[js/path-injection]
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    if (!isSafeBundleSegment(f.name)) {
      throw new Error(`Invalid bundle file name: ${f.name}`);
    }
    // isSafeBundleSegment rejects separators, NUL, and '..'; dir is a
    // validated path under the server-controlled bundle root.
    const filePath = path.join(dir, f.name);
    // codeql[js/path-injection]
    await writeFile(filePath, Buffer.from(f.contentBase64, 'base64'));
  }
  return dir;
}

/** Remove a bundle directory (best-effort). */
export async function removeBundleDir(dir: string): Promise<void> {
  const root = getBundleRoot();
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('Refusing to remove a path outside the bundle root');
  }
  await rm(resolved, { recursive: true, force: true });
}

/** Absolute path for a served bundle file, or null when unsafe/missing. */
export function resolveBundleFilePath(
  nodeId: string,
  hash: string,
  fileName: string
): string | null {
  if (!isSafeId(nodeId)) return null;
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  if (!isSafeBundleSegment(fileName)) return null;
  return path.join(getBundleRoot(), nodeId, hash, fileName);
}

/** Public URLs for a bundle's files. */
export function bundleUrls(
  nodeId: string,
  hash: string,
  files: BundleFile[]
): { scripts: string[]; styles: string[] } {
  const scripts: string[] = [];
  const styles: string[] = [];
  for (const f of files) {
    const target = f.name.endsWith('.css') ? styles : scripts;
    const base = f.name.endsWith('.css') ? 'plugin-styles' : 'plugin-scripts';
    target.push(`/${base}/${nodeId}/${hash}/${f.name}`);
  }
  return { scripts, styles };
}

/**
 * Public URLs for an ALREADY-STORED bundle, derived from the files on disk.
 * Used by the UI manifest so the client can inject `<script>`/`<link>` tags
 * without knowing the directory layout. Returns empty lanes when the
 * directory is missing.
 */
export async function bundleFileUrls(
  nodeId: string,
  hash: string,
  dir: string
): Promise<{ scripts: string[]; styles: string[] }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { scripts: [], styles: [] };
  }
  const files: BundleFile[] = names.map(name => ({
    name,
    contentBase64: '',
  }));
  return bundleUrls(nodeId, hash, files);
}
