import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('Coordinator Wiki Storage', () => {
  let kbDir: string;

  beforeEach(async () => {
    kbDir = await mkdtemp(path.join(os.tmpdir(), 'drone-coordinator-wiki-'));
    const { setKnowledgeBaseDir } = await import('../src/wiki-storage.js');
    setKnowledgeBaseDir(kbDir);
  });

  afterEach(async () => {
    await rm(kbDir, { recursive: true, force: true });
  });

  it('should write and read a wiki page', async () => {
    const { writePage, readPage } = await import('../src/wiki-storage.js');
    const page = await writePage(
      'test-page',
      'Test Page',
      'coordinator',
      '# Hello World'
    );
    expect(page.id).toBe('test-page');
    expect(page.title).toBe('Test Page');
    expect(page.scope).toBe('coordinator');
    expect(page.content).toBe('# Hello World');

    const read = await readPage('test-page');
    expect(read).not.toBeNull();
    expect(read!.title).toBe('Test Page');
    expect(read!.content).toBe('# Hello World');
  });

  it('should return null for non-existent page', async () => {
    const { readPage } = await import('../src/wiki-storage.js');
    expect(await readPage('nonexistent')).toBeNull();
  });

  it('should delete a wiki page', async () => {
    const { writePage, deletePage, readPage } =
      await import('../src/wiki-storage.js');
    await writePage('test-page', 'Test', 'coordinator', 'content');
    expect(await deletePage('test-page')).toBe(true);
    expect(await readPage('test-page')).toBeNull();
  });

  it('should return true when deleting non-existent page (rm with force)', async () => {
    const { deletePage } = await import('../src/wiki-storage.js');
    // rm with force:true succeeds even for non-existent files
    expect(await deletePage('nonexistent')).toBe(true);
  });

  it('should list all pages', async () => {
    const { writePage, listPages } = await import('../src/wiki-storage.js');
    await writePage('page-1', 'Page 1', 'coordinator', 'content 1');
    await writePage('page-2', 'Page 2', 'coordinator', 'content 2');
    const pages = await listPages();
    expect(pages).toHaveLength(2);
  });

  it('should search pages by title', async () => {
    const { writePage, searchPages } = await import('../src/wiki-storage.js');
    await writePage('arch', 'Architecture', 'coordinator', 'System design');
    await writePage('deploy', 'Deployment', 'coordinator', 'How to deploy');
    const results = await searchPages('Architecture');
    expect(results).toHaveLength(1);
    expect(results[0].page.id).toBe('arch');
    expect(results[0].score).toBe(1.0);
  });

  it('should search pages by content', async () => {
    const { writePage, searchPages } = await import('../src/wiki-storage.js');
    await writePage(
      'arch',
      'Architecture',
      'coordinator',
      'Uses microservices pattern'
    );
    const results = await searchPages('microservices');
    expect(results).toHaveLength(1);
  });

  it('should search pages by tag', async () => {
    const { writePage, searchPages } = await import('../src/wiki-storage.js');
    await writePage('arch', 'Architecture', 'coordinator', 'content', [
      'system-design',
    ]);
    const results = await searchPages('system-design');
    expect(results).toHaveLength(1);
  });

  it('should return empty array for no matches', async () => {
    const { searchPages } = await import('../src/wiki-storage.js');
    expect(await searchPages('nonexistent')).toHaveLength(0);
  });

  it('should lint pages and find orphans', async () => {
    const { writePage, lintPages } = await import('../src/wiki-storage.js');
    await writePage('page-1', 'Page 1', 'coordinator', 'content');
    const result = await lintPages();
    expect(result.issues.some(i => i.type === 'orphan')).toBe(true);
  });

  it('should lint pages and find broken links', async () => {
    const { writePage, lintPages } = await import('../src/wiki-storage.js');
    await writePage('page-1', 'Page 1', 'coordinator', 'See [[nonexistent]]');
    const result = await lintPages();
    expect(result.issues.some(i => i.type === 'broken-link')).toBe(true);
  });

  it('should enforce no downward links from coordinator to beacon', async () => {
    const { writePage } = await import('../src/wiki-storage.js');
    await writePage('beacon-page', 'Beacon Page', 'beacon', 'beacon content');
    await expect(
      writePage(
        'coord-page',
        'Coord Page',
        'coordinator',
        'See [[beacon-page]]'
      )
    ).rejects.toThrow('Cannot link');
  });

  it('should allow upward links from beacon to coordinator', async () => {
    const { writePage } = await import('../src/wiki-storage.js');
    await writePage('coord-page', 'Coord Page', 'coordinator', 'coord content');
    const page = await writePage(
      'beacon-page',
      'Beacon Page',
      'beacon',
      'See [[coord-page]]'
    );
    expect(page.id).toBe('beacon-page');
  });

  it('should preserve createdAt on update', async () => {
    const { writePage } = await import('../src/wiki-storage.js');
    const first = await writePage('test', 'Test', 'coordinator', 'v1');
    await new Promise(r => setTimeout(r, 10));
    const second = await writePage('test', 'Test Updated', 'coordinator', 'v2');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });
});
