import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setupDb, teardownDb } from './setup.js';
import {
  listWikiSources,
  getWikiChunks,
  searchWikiChunksByVector,
} from '../src/db/index.js';
import type { WikiOrigin } from '../src/db/index.js';
import { WikiIndexer } from '../src/wiki-indexer.js';
import type { WikiPageInput, WikiIndexResult } from '../src/wiki-indexer.js';
import { setKnowledgeBaseDir, writePage } from '../../drone-swarm-common/src/index.js';
import type { DroneEmbeddingProvider } from 'drone-core';

function fakeEmbedding(activeIndex: number): Float32Array {
  const v = new Float32Array(768);
  v[activeIndex] = 1;
  return v;
}

function keywordToIndex(keyword: string): number {
  let h = 0;
  for (let i = 0; i < keyword.length; i++) {
    h = (h * 31 + keyword.charCodeAt(i)) % 768;
  }
  return h;
}

/** Deterministic fake embedder: keyword in text maps to a basis vector. */
function makeProvider(): DroneEmbeddingProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: 'fake',
    name: 'Fake Embedder',
    dimensions: 768,
    maxTokens: 8192,
    calls,
    getEmbedding: vi.fn(async (text: string) => {
      calls.push(text);
      for (const kw of ['fragment', 'persona', 'beacon']) {
        if (text.toLowerCase().includes(kw)) {
          return fakeEmbedding(keywordToIndex(kw));
        }
      }
      return fakeEmbedding(keywordToIndex('unmatched'));
    }),
  };
}

const BEACON_PAGE_META = {
  id: 'fragments-guide',
  title: 'Fragment Guide',
  scope: 'beacon' as const,
  tags: ['fragments'],
  sources: ['session-1'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const COORDINATOR_PAGE_META = {
  id: 'fragments-guide',
  title: 'Fragment Guide (Coordinator)',
  scope: 'coordinator' as const,
  tags: ['fragments'],
  sources: ['session-2'],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-02-01T00:00:00Z',
};

describe('WikiIndexer', () => {
  beforeEach(async () => {
    await setupDb();
    const kbDir = await mkdtemp(path.join(os.tmpdir(), 'wiki-kb-'));
    setKnowledgeBaseDir(kbDir);
  });

  afterEach(async () => {
    await teardownDb();
  });

  function makeIndexer(): WikiIndexer {
    return new WikiIndexer(makeProvider());
  }

  it('indexes beacon-origin pages (content from disk) and coordinator pages (explicit content)', async () => {
    await writePage(
      'fragments-guide',
      'Fragment Guide',
      'beacon',
      '# Fragments\n\nBeacon fragment details.'
    );
    const indexer = new WikiIndexer(makeProvider());
    const pages: WikiPageInput[] = [
      { page: BEACON_PAGE_META, origin: 'beacon' },
      { page: COORDINATOR_PAGE_META, origin: 'coordinator', content: '# Fragment sync\n\nCoordinator fragment details.' },
    ];

    const result = await indexer.indexWiki(pages);
    expect(result.pagesIndexed).toBe(2);
    expect(result.pagesRemoved).toBe(0);
    expect(listWikiSources()).toHaveLength(2);
    expect(getWikiChunks('fragments-guide', 'beacon').length).toBeGreaterThan(0);
    expect(getWikiChunks('fragments-guide', 'coordinator').length).toBeGreaterThan(0);
  });

  it('skips unchanged pages', async () => {
    await writePage(
      'fragments-guide',
      'Fragment Guide',
      'beacon',
      '# Fragments\n\nBeacon fragment details.'
    );
    const provider = makeProvider();
    const indexer = new WikiIndexer(provider);
    const pages: WikiPageInput[] = [{ page: BEACON_PAGE_META, origin: 'beacon' }];

    const first = await indexer.indexWiki(pages);
    expect(first.pagesIndexed).toBe(1);

    const second = await indexer.indexWiki(pages);
    expect(second.pagesSkipped).toBe(1);
    expect(second.pagesIndexed).toBe(0);

    const src = listWikiSources().find(s => s.origin === 'beacon');
    expect(src).toBeDefined();
  });

  it('removes pages absent from a later authoritative set (local delete → reconcile)', async () => {
    const indexer = new WikiIndexer(makeProvider());
    await indexer.indexWiki([
      { page: BEACON_PAGE_META, origin: 'beacon', content: '# Fragment guide\n\nBeacon fragment details.' },
    ]);
    expect(listWikiSources()).toHaveLength(1);

    const second: WikiIndexResult = await indexer.indexWiki([]);
    expect(second.pagesRemoved).toBe(1);
    expect(listWikiSources()).toHaveLength(0);
    expect(getWikiChunks('fragments-guide', 'beacon')).toHaveLength(0);
  });

  it('coordinator pages with explicit content are indexed without a local file', async () => {
    const indexer = new WikiIndexer(makeProvider());
    const result = await indexer.indexWiki([
      { page: COORDINATOR_PAGE_META, origin: 'coordinator', content: '# Fragment TTL\n\nTTL sweep details.' },
    ]);
    expect(result.pagesIndexed).toBe(1);
    expect(getWikiChunks('fragments-guide', 'coordinator')[0].text).toContain('TTL sweep');
  });

  it('reconciles both origins independently for the same pageId', async () => {
    const indexer = new WikiIndexer(makeProvider());
    await indexer.indexWiki([
      { page: BEACON_PAGE_META, origin: 'beacon', content: '# Fragment guide\n\nBeacon fragment details.' },
      { page: COORDINATOR_PAGE_META, origin: 'coordinator', content: '# Fragment sync\n\nCoordinator details.' },
    ]);
    expect(listWikiSources()).toHaveLength(2);

    // Coordinator version is gone from the authoritative set; beacon persists.
    await indexer.indexWiki([
      { page: BEACON_PAGE_META, origin: 'beacon', content: '# Fragment guide\n\nBeacon fragment details.' },
    ]);
    expect(
      listWikiSources().find(s => s.page_id === 'fragments-guide' && s.origin === 'beacon')
    ).toBeDefined();
    expect(
      listWikiSources().find(s => s.page_id === 'fragments-guide' && s.origin === 'coordinator')
    ).toBeUndefined();
   });
});