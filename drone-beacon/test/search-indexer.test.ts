import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectFiles, SearchIndexer } from '../src/search-indexer.js';
import { setupDb, teardownDb } from './setup.js';
import * as db from '../src/db/index.js';

const mockProvider = {
  id: 'mock',
  name: 'Mock Provider',
  dimensions: 768,
  maxTokens: 8192,
  getEmbedding: async () => {
    const arr = new Float32Array(768);
    arr[0] = 1;
    return arr;
  },
};

beforeEach(async () => {
  await setupDb();
});

afterEach(async () => {
  await teardownDb();
});

describe('collectFiles', () => {
  it('skips .git, node_modules, hidden dirs/files, and binary files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'drone-collect-'));
    try {
      // Source file that should be indexed
      const srcDir = path.join(root, 'src');
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(srcDir, 'a.ts'), 'export const a = 1;\n');

      // Always-skip directories
      await mkdir(path.join(root, '.git'), { recursive: true });
      await writeFile(path.join(root, '.git', 'config'), '[core]');
      await mkdir(path.join(root, 'node_modules'), { recursive: true });
      await writeFile(path.join(root, 'node_modules', 'dep.js'), 'x');

      // Hidden directory (not .git/node_modules) — still skipped
      await mkdir(path.join(root, '.hidden-dir'), { recursive: true });
      await writeFile(path.join(root, '.hidden-dir', 'secret.txt'), 's');

      // Binary file — skipped
      await writeFile(path.join(srcDir, 'data.png'), Buffer.from([0, 1, 2]));

      const result = new Set<string>();
      await collectFiles(root, result);

      const paths = [...result].map(p => path.relative(root, p));
      expect(paths).toContain(path.join('src', 'a.ts'));
      expect(paths).not.toContain(path.join('.git', 'config'));
      expect(paths).not.toContain(path.join('node_modules', 'dep.js'));
      expect(paths).not.toContain(path.join('.hidden-dir', 'secret.txt'));
      expect(paths).not.toContain(path.join('src', 'data.png'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns an empty set for a directory with no indexable files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'drone-collect-'));
    try {
      await writeFile(path.join(root, '.gitignore'), '*');
      const result = new Set<string>();
      await collectFiles(root, result);
      expect(result.size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('SearchIndexer.indexDirectory', () => {
  it('routes files through chunkFile by extension', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'drone-index-'));
    try {
      await writeFile(
        path.join(root, 'a.ts'),
        'export function add(a: number, b: number): number {\n  return a + b;\n}\n'
      );
      await writeFile(path.join(root, 'b.md'), '# Title\n\nBody text here.\n');

      const indexer = new SearchIndexer(mockProvider);
      const result = await indexer.indexDirectory(root);

      expect(result.filesIndexed).toBe(2);
      expect(result.chunksCreated).toBeGreaterThan(0);

      const chunks = db.getAllChunks(root);
      const texts = chunks.map(c => c.text).join('\n');
      expect(texts).toContain('export function add');
      expect(texts).toContain('# Title');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
