import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  isSafeId,
  isSafeBundleSegment,
  resolveBundleFilePath,
} from '../src/extension-bundles.js';

beforeEach(async () => {
  await setupDb();
});

afterEach(async () => {
  await teardownDb();
});

describe('isSafeBundleSegment', () => {
  it('accepts ordinary bundle file names', () => {
    expect(isSafeBundleSegment('index.js')).toBe(true);
    expect(isSafeBundleSegment('style.css')).toBe(true);
    expect(isSafeBundleSegment('panel.v2.min.js')).toBe(true);
    expect(isSafeBundleSegment('_chunk-3.js')).toBe(true);
  });

  it('rejects directory-traversal characters and sequences', () => {
    expect(isSafeBundleSegment('../evil.js')).toBe(false);
    expect(isSafeBundleSegment('a/b.js')).toBe(false);
    expect(isSafeBundleSegment('a\\b.js')).toBe(false);
    expect(isSafeBundleSegment('..')).toBe(false);
    expect(isSafeBundleSegment('.')).toBe(false);
    expect(isSafeBundleSegment('...')).toBe(false);
    expect(isSafeBundleSegment('a\0b.js')).toBe(false);
  });

  it('rejects empty and over-long segments', () => {
    expect(isSafeBundleSegment('')).toBe(false);
    expect(isSafeBundleSegment('a'.repeat(256))).toBe(false);
  });

  it('rejects characters outside the conservative class', () => {
    expect(isSafeBundleSegment('a b.js')).toBe(false);
    expect(isSafeBundleSegment('a:b.js')).toBe(false);
    expect(isSafeBundleSegment('a$b.js')).toBe(false);
  });
});

describe('isSafeId', () => {
  it('accepts ordinary node ids (no dots, no slashes)', () => {
    expect(isSafeId('mcp-swarm')).toBe(true);
    expect(isSafeId('node_1')).toBe(true);
  });

  it('rejects traversal, empty, and over-long ids', () => {
    expect(isSafeId('../x')).toBe(false);
    expect(isSafeId('a/b')).toBe(false);
    expect(isSafeId('')).toBe(false);
    expect(isSafeId('a'.repeat(256))).toBe(false);
  });
});

describe('resolveBundleFilePath', () => {
  it('returns null for an unsafe file name', () => {
    const hash = 'a'.repeat(64);
    expect(resolveBundleFilePath('node-1', hash, '../evil.js')).toBeNull();
  });

  it('returns null for an unsafe node id', () => {
    const hash = 'a'.repeat(64);
    expect(resolveBundleFilePath('../node', hash, 'index.js')).toBeNull();
  });

  it('resolves a safe triple under the bundle root', () => {
    const hash = 'a'.repeat(64);
    const filePath = resolveBundleFilePath('node-1', hash, 'index.js');
    expect(filePath).toContain('extension-bundles');
    expect(filePath?.endsWith('index.js')).toBe(true);
  });
});
