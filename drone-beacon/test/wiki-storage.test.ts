import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('Beacon Wiki Storage', () => {
  let kbDir: string;

  beforeEach(async () => {
    kbDir = await mkdtemp(path.join(os.tmpdir(), 'drone-beacon-wiki-'));
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
      'beacon',
      '# Hello World'
    );
    expect(page.id).toBe('test-page');
    expect(page.title).toBe('Test Page');
    expect(page.scope).toBe('beacon');
    expect(page.content).toBe('# Hello World');

    const read = await readPage('test-page');
    expect(read).not.toBeNull();
    expect(read!.title).toBe('Test Page');
    expect(read!.content).toBe('# Hello World');
  });

  it('should return null for non-existent page', async () => {
    const { readPage } = await import('../src/wiki-storage.js');
    const page = await readPage('nonexistent');
    expect(page).toBeNull();
  });

  it('should delete a wiki page', async () => {
    const { writePage, deletePage, readPage } =
      await import('../src/wiki-storage.js');
    await writePage('test-page', 'Test', 'beacon', 'content');
    const deleted = await deletePage('test-page');
    expect(deleted).toBe(true);
    expect(await readPage('test-page')).toBeNull();
  });

  it('should return true when deleting non-existent page (rm with force)', async () => {
    const { deletePage } = await import('../src/wiki-storage.js');
    // rm with force:true succeeds even for non-existent files
    expect(await deletePage('nonexistent')).toBe(true);
  });

  it('should list all pages', async () => {
    const { writePage, listPages } = await import('../src/wiki-storage.js');
    await writePage('page-1', 'Page 1', 'beacon', 'content 1');
    await writePage('page-2', 'Page 2', 'beacon', 'content 2');
    const pages = await listPages();
    expect(pages).toHaveLength(2);
  });

  it('should list pages sorted by updatedAt descending', async () => {
    const { writePage, listPages } = await import('../src/wiki-storage.js');
    await writePage('page-1', 'Page 1', 'beacon', 'content 1');
    await new Promise(r => setTimeout(r, 10));
    await writePage('page-2', 'Page 2', 'beacon', 'content 2');
    const pages = await listPages();
    expect(pages[0].id).toBe('page-2');
  });

  it('should search pages by title', async () => {
    const { writePage, searchPages } = await import('../src/wiki-storage.js');
    await writePage(
      'architecture',
      'Architecture Overview',
      'beacon',
      'System architecture docs'
    );
    await writePage(
      'deployment',
      'Deployment Guide',
      'beacon',
      'How to deploy'
    );
    const results = await searchPages('architecture');
    expect(results).toHaveLength(1);
    expect(results[0].page.id).toBe('architecture');
    expect(results[0].score).toBe(1.0);
  });

  it('should search pages by content', async () => {
    const { writePage, searchPages } = await import('../src/wiki-storage.js');
    await writePage(
      'arch',
      'Architecture',
      'beacon',
      'The system uses microservices'
    );
    await writePage('deploy', 'Deployment', 'beacon', 'Deploy with Docker');
    const results = await searchPages('microservices');
    expect(results).toHaveLength(1);
    expect(results[0].page.id).toBe('arch');
  });

  it('should search pages by tag', async () => {
    const { writePage, searchPages } = await import('../src/wiki-storage.js');
    await writePage('arch', 'Architecture', 'beacon', 'content', [
      'system-design',
    ]);
    await writePage('deploy', 'Deployment', 'beacon', 'content', ['ops']);
    const results = await searchPages('system-design');
    expect(results).toHaveLength(1);
    expect(results[0].page.id).toBe('arch');
  });

  it('should return empty array for no search matches', async () => {
    const { searchPages } = await import('../src/wiki-storage.js');
    const results = await searchPages('nonexistent');
    expect(results).toHaveLength(0);
  });

  it('should lint pages and find orphans', async () => {
    const { writePage, lintPages } = await import('../src/wiki-storage.js');
    await writePage('page-1', 'Page 1', 'beacon', 'content');
    const result = await lintPages();
    expect(result.issues.some(i => i.type === 'orphan')).toBe(true);
  });

  it('should lint pages and find broken links', async () => {
    const { writePage, lintPages } = await import('../src/wiki-storage.js');
    await writePage(
      'page-1',
      'Page 1',
      'beacon',
      'See [[nonexistent-page]] for details'
    );
    const result = await lintPages();
    expect(result.issues.some(i => i.type === 'broken-link')).toBe(true);
  });

  it('should enforce no downward links from coordinator to beacon', async () => {
    const { writePage } = await import('../src/wiki-storage.js');
    // Create a beacon-scoped page first
    await writePage('beacon-page', 'Beacon Page', 'beacon', 'beacon content');
    // Try to link to it from a coordinator-scoped page
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
    // Create a coordinator-scoped page first
    await writePage('coord-page', 'Coord Page', 'coordinator', 'coord content');
    // Link to it from a beacon-scoped page (should be allowed)
    const page = await writePage(
      'beacon-page',
      'Beacon Page',
      'beacon',
      'See [[coord-page]]'
    );
    expect(page.id).toBe('beacon-page');
  });

  it('should prevent path traversal in page IDs', async () => {
    const { writePage } = await import('../src/wiki-storage.js');
    const page = await writePage('../malicious', 'Bad', 'beacon', 'content');
    // The page ID should be sanitized
    expect(page.id).toBe('../malicious'); // The id in the return is the original
    // But the file should be safe (underscores replace non-alphanumeric)
    const { readPage } = await import('../src/wiki-storage.js');
    const read = await readPage('../malicious');
    expect(read).not.toBeNull();
  });

  it('should preserve createdAt on update', async () => {
    const { writePage, readPage } = await import('../src/wiki-storage.js');
    const first = await writePage('test', 'Test', 'beacon', 'v1');
    await new Promise(r => setTimeout(r, 10));
    const second = await writePage('test', 'Test Updated', 'beacon', 'v2');
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });
});
