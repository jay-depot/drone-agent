import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildBundleFiles } from '../src/bundle.js';

describe('buildBundleFiles', () => {
  it('throws a clear error when the bundle is absent', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dsp-bundle-'));
    try {
      await expect(buildBundleFiles(dir)).rejects.toThrow(
        /bundle file missing/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
