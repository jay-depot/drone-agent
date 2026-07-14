import { mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import path from 'path';
import crypto from 'crypto';
import { logger } from './logger.js';

const LARGE_PAYLOAD_THRESHOLD = 10 * 1024; // 10KB
const BLOB_DIR = 'blobs';

let storageDir: string | null = null;

export async function initStorage(baseDir: string): Promise<void> {
  storageDir = path.join(baseDir, BLOB_DIR);
  await mkdir(storageDir, { recursive: true });
  logger.info(`Storage engine initialized at: ${storageDir}`);
}

export function getStorageDir(): string {
  if (!storageDir) {
    throw new Error('Storage not initialized. Call initStorage() first.');
  }
  return storageDir;
}

/**
 * Check if a payload exceeds the large payload threshold.
 */
export function isLargePayload(payload: string): boolean {
  return Buffer.byteLength(payload, 'utf-8') > LARGE_PAYLOAD_THRESHOLD;
}

/**
 * Store a large payload on disk and return a reference string.
 * The reference format is: "blob:<sessionId>/<eventId>/<hash>"
 */
export async function storeLargePayload(
  sessionId: string,
  eventId: string,
  content: string
): Promise<string> {
  const dir = getStorageDir();
  const sessionDir = path.join(dir, sessionId);
  await mkdir(sessionDir, { recursive: true });

  const hash = crypto
    .createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, 16);
  const filename = `${eventId}-${hash}.blob`;
  const filePath = path.join(sessionDir, filename);

  await writeFile(filePath, content, 'utf-8');
  const ref = `blob:${sessionId}/${eventId}/${hash}`;

  logger.debug(
    `Stored large payload: ${ref} (${Buffer.byteLength(content, 'utf-8')} bytes)`
  );
  return ref;
}

/**
 * Retrieve a large payload from disk by reference string.
 */
export async function retrieveLargePayload(
  ref: string
): Promise<string | null> {
  // Parse reference: "blob:<sessionId>/<eventId>/<hash>"
  const match = ref.match(/^blob:([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) {
    logger.warn(`Invalid blob reference: ${ref}`);
    return null;
  }

  const [, sessionId, eventId, hash] = match;
  const dir = getStorageDir();
  const sessionDir = path.join(dir, sessionId);

  // Search for matching blob file
  const prefix = `${eventId}-${hash}`;
  try {
    const files = await readdir(sessionDir);
    for (const file of files) {
      if (file.startsWith(prefix) && file.endsWith('.blob')) {
        const content = await readFile(path.join(sessionDir, file), 'utf-8');
        return content;
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  logger.warn(`Blob not found: ${ref}`);
  return null;
}

/**
 * Delete all blob files for a given session.
 */
export async function deleteSessionBlobs(sessionId: string): Promise<void> {
  const dir = getStorageDir();
  const sessionDir = path.join(dir, sessionId);
  try {
    await rm(sessionDir, { recursive: true, force: true });
    logger.debug(`Deleted blobs for session: ${sessionId}`);
  } catch {
    // Directory doesn't exist
  }
}
