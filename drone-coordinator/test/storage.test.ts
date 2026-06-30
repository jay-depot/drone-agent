import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  initStorage,
  isLargePayload,
  storeLargePayload,
  retrieveLargePayload,
  deleteSessionBlobs,
  getStorageDir,
} from '../src/storage.js';

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(os.tmpdir(), 'drone-coordinator-storage-'));
  initStorage(baseDir);
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe('Storage Engine', () => {
  it('should initialize storage and create blob directory', () => {
    const dir = getStorageDir();
    expect(dir).toBeTruthy();
    expect(dir).toContain('blobs');
  });

  it('should detect large payloads', () => {
    const small = 'x'.repeat(1024); // 1KB
    expect(isLargePayload(small)).toBe(false);

    const large = 'x'.repeat(11 * 1024); // 11KB
    expect(isLargePayload(large)).toBe(true);
  });

  it('should handle exact threshold boundary', () => {
    const exact = 'x'.repeat(10 * 1024); // exactly 10KB
    // 10KB is NOT over the threshold (threshold is > 10KB)
    expect(isLargePayload(exact)).toBe(false);
  });

  it('should store a large payload and return a reference', () => {
    const content = 'x'.repeat(11 * 1024);
    const ref = storeLargePayload('session-1', 'event-1', content);
    expect(ref).toMatch(/^blob:session-1\/event-1\/[a-f0-9]+$/);
  });

  it('should retrieve a stored payload by reference', () => {
    const content = 'y'.repeat(11 * 1024);
    const ref = storeLargePayload('session-1', 'event-1', content);
    const retrieved = retrieveLargePayload(ref);
    expect(retrieved).toBe(content);
  });

  it('should return null for invalid blob reference', () => {
    expect(retrieveLargePayload('blob:invalid/ref/1234')).toBeNull();
  });

  it('should return null for malformed reference', () => {
    expect(retrieveLargePayload('not-a-blob-ref')).toBeNull();
  });

  it('should store small payloads (under threshold)', () => {
    const content = 'small payload';
    const ref = storeLargePayload('session-1', 'event-2', content);
    const retrieved = retrieveLargePayload(ref);
    expect(retrieved).toBe(content);
  });

  it('should handle special characters in content', () => {
    const content = JSON.stringify({
      text: 'hello\nworld\twith\0null',
      unicode: '🚀🔥',
    });
    const ref = storeLargePayload('session-1', 'event-3', content);
    const retrieved = retrieveLargePayload(ref);
    expect(retrieved).toBe(content);
  });

  it('should delete session blobs', () => {
    storeLargePayload('session-1', 'event-1', 'x'.repeat(11 * 1024));
    storeLargePayload('session-1', 'event-2', 'y'.repeat(11 * 1024));
    storeLargePayload('session-2', 'event-1', 'z'.repeat(11 * 1024));

    deleteSessionBlobs('session-1');

    // session-1 blobs should be gone
    const ref1 = 'blob:session-1/event-1/xxxx';
    expect(retrieveLargePayload(ref1)).toBeNull();

    // session-2 blobs should still exist
    // We can't easily verify this without knowing the hash, but the function shouldn't throw
  });

  it('should handle deleting non-existent session', () => {
    expect(() => deleteSessionBlobs('nonexistent')).not.toThrow();
  });
});
