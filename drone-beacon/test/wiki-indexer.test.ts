import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setupDb, teardownDb } from './setup.js';
import {
  getDatabase,
  listWikiSources,
  getWikiChunks,
} from '../src/db/index.js';
import { WikiIndexer } from '../src/wiki-indexer.js';
import type { WikiPageInput, WikiIndexResult } from '../src/wiki-indexer.js';
import {
  countWikiFtsRows,
  hasWikiFtsRows,
  searchWikiFts,
  setKnowledgeBaseDir,
  writePage,
} from '../../drone-swarm-common/src/index.js';
import { NOMIC_EMBED_TEXT_V1_5, type DroneEmbeddingProvider } from 'drone-core';

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
  const embed = vi.fn(async (text: string) => {
    calls.push(text);
    for (const kw of ['fragment', 'persona', 'beacon']) {
      if (text.toLowerCase().includes(kw)) {
        return fakeEmbedding(keywordToIndex(kw));
      }
    }
    return fakeEmbedding(keywordToIndex('unmatched'));
  });
  return {
    id: 'fake',
    name: 'Fake Embedder',
    spec: NOMIC_EMBED_TEXT_V1_5,
    dimensions: 768,
    maxTokens: 8192,
    calls,
    getEmbedding: embed,
    embedQuery: embed,
    embedDocument: embed,
  };
}

const BEACON_PAGE_META = {
  id: 'fragments-guide',
  title: 'Fragment Guide',
  scope: 'beacon' as const,
  tags: ['fragments'],
  sources: ['session-1'],
  wordCount: 0,
  linkCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const COORDINATOR_PAGE_META = {
  id: 'fragments-guide',
  title: 'Fragment Guide (Coordinator)',
  scope: 'coordinator' as const,
  tags: ['fragments'],
  sources: ['session-2'],
  wordCount: 0,
  linkCount: 0,
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
      {
        page: COORDINATOR_PAGE_META,
        origin: 'coordinator',
        content: '# Fragment sync\n\nCoordinator fragment details.',
      },
    ];

    const result = await indexer.indexWiki(pages);
    expect(result.pagesIndexed).toBe(2);
    expect(result.pagesRemoved).toBe(0);
    expect(listWikiSources()).toHaveLength(2);
    expect(getWikiChunks('fragments-guide', 'beacon').length).toBeGreaterThan(
      0
    );
    expect(
      getWikiChunks('fragments-guide', 'coordinator').length
    ).toBeGreaterThan(0);
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
    const pages: WikiPageInput[] = [
      { page: BEACON_PAGE_META, origin: 'beacon' },
    ];

    const first = await indexer.indexWiki(pages);
    expect(first.pagesIndexed).toBe(1);

    const second = await indexer.indexWiki(pages);
    expect(second.pagesSkipped).toBe(1);
    expect(second.pagesIndexed).toBe(0);

    const src = listWikiSources().find(s => s.origin === 'beacon');
    expect(src).toBeDefined();
  });

  it('does not double the chunk count when a page changes', async () => {
    const indexer = new WikiIndexer(makeProvider());
    const first = await indexer.indexWiki([
      {
        page: BEACON_PAGE_META,
        origin: 'beacon',
        content: '# Fragments\n\nBeacon fragment details.',
      },
    ]);
    expect(first.pagesIndexed).toBe(1);
    const before = getWikiChunks('fragments-guide', 'beacon').length;
    expect(before).toBe(1);

    const changed = { ...BEACON_PAGE_META, updatedAt: '2026-02-02T00:00:00Z' };
    const second = await indexer.indexWiki([
      {
        page: changed,
        origin: 'beacon',
        content: '# Fragments\n\nChanged fragment details.',
      },
    ]);
    expect(second.pagesIndexed).toBe(1);

    const chunks = getWikiChunks('fragments-guide', 'beacon');
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Changed fragment details');
  });

  it('leaves no source row when an embed throws, then recovers on retry', async () => {
    let fail = true;
    const provider: DroneEmbeddingProvider = {
      id: 'flaky',
      name: 'Flaky',
      spec: NOMIC_EMBED_TEXT_V1_5,
      dimensions: 768,
      maxTokens: 8192,
      getEmbedding: async () => fakeEmbedding(1),
      embedQuery: async () => fakeEmbedding(1),
      embedDocument: async () => {
        if (fail) throw new Error('boom');
        return fakeEmbedding(keywordToIndex('fragment'));
      },
    };
    const indexer = new WikiIndexer(provider);
    const pages: WikiPageInput[] = [
      {
        page: BEACON_PAGE_META,
        origin: 'beacon',
        content: '# Fragments\n\nBeacon fragment details.',
      },
    ];

    const first = await indexer.indexWiki(pages);
    expect(first.pagesIndexed).toBe(0);
    expect(
      listWikiSources().find(s => s.page_id === 'fragments-guide')
    ).toBeUndefined();
    expect(getWikiChunks('fragments-guide', 'beacon')).toHaveLength(0);

    fail = false;
    const second = await indexer.indexWiki(pages);
    expect(second.pagesIndexed).toBe(1);
    expect(getWikiChunks('fragments-guide', 'beacon').length).toBeGreaterThan(
      0
    );
  });

  it('removes pages absent from a later authoritative set (local delete → reconcile)', async () => {
    const indexer = new WikiIndexer(makeProvider());
    await indexer.indexWiki([
      {
        page: BEACON_PAGE_META,
        origin: 'beacon',
        content: '# Fragment guide\n\nBeacon fragment details.',
      },
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
      {
        page: COORDINATOR_PAGE_META,
        origin: 'coordinator',
        content: '# Fragment TTL\n\nTTL sweep details.',
      },
    ]);
    expect(result.pagesIndexed).toBe(1);
    expect(getWikiChunks('fragments-guide', 'coordinator')[0].text).toContain(
      'TTL sweep'
    );
  });

  it('reconciles both origins independently for the same pageId', async () => {
    const indexer = new WikiIndexer(makeProvider());
    await indexer.indexWiki([
      {
        page: BEACON_PAGE_META,
        origin: 'beacon',
        content: '# Fragment guide\n\nBeacon fragment details.',
      },
      {
        page: COORDINATOR_PAGE_META,
        origin: 'coordinator',
        content: '# Fragment sync\n\nCoordinator details.',
      },
    ]);
    expect(listWikiSources()).toHaveLength(2);

    // Coordinator version is gone from the authoritative set; beacon persists.
    await indexer.indexWiki([
      {
        page: BEACON_PAGE_META,
        origin: 'beacon',
        content: '# Fragment guide\n\nBeacon fragment details.',
      },
    ]);
    expect(
      listWikiSources().find(
        s => s.page_id === 'fragments-guide' && s.origin === 'beacon'
      )
    ).toBeDefined();
    expect(
      listWikiSources().find(
        s => s.page_id === 'fragments-guide' && s.origin === 'coordinator'
      )
    ).toBeUndefined();
  });

  describe('keyword (FTS) index', () => {
    it('populates the keyword index when a page is indexed', async () => {
      const indexer = new WikiIndexer(makeProvider());
      await indexer.indexWiki([
        {
          page: BEACON_PAGE_META,
          origin: 'beacon',
          content: '# Fragment guide\n\nBeacon fragment details.',
        },
      ]);

      const hits = searchWikiFts(() => getDatabase(), 'fragment', {
        mode: 'stemmed',
      });
      expect(hits.map(h => h.pageId)).toContain('fragments-guide');
      expect(
        hasWikiFtsRows(() => getDatabase(), 'fragments-guide', 'beacon')
      ).toBe(true);
    });

    it('indexes the page title and tags, not just the body', async () => {
      const indexer = new WikiIndexer(makeProvider());
      await indexer.indexWiki([
        {
          page: BEACON_PAGE_META,
          origin: 'beacon',
          content: '# Fragment guide\n\nBeacon fragment details.',
        },
      ]);

      // "Guide" and "fragments" appear only in the title/tags.
      expect(
        searchWikiFts(() => getDatabase(), 'guide', { mode: 'stemmed' })
      ).toHaveLength(1);
      expect(
        searchWikiFts(() => getDatabase(), 'fragments', { mode: 'stemmed' })
      ).toHaveLength(1);
    });

    it('removes keyword rows when a page is reconciled away', async () => {
      const indexer = new WikiIndexer(makeProvider());
      await indexer.indexWiki([
        {
          page: BEACON_PAGE_META,
          origin: 'beacon',
          content: '# Fragment guide\n\nBeacon fragment details.',
        },
      ]);
      expect(countWikiFtsRows(() => getDatabase())).toBe(1);

      await indexer.indexWiki([]);
      expect(countWikiFtsRows(() => getDatabase())).toBe(0);
    });

    it('replaces rather than duplicates keyword rows when a page changes', async () => {
      const indexer = new WikiIndexer(makeProvider());
      const first = await indexer.indexWiki([
        {
          page: BEACON_PAGE_META,
          origin: 'beacon',
          content: '# Fragment guide\n\nOriginal body text.',
        },
      ]);
      expect(first.pagesIndexed).toBe(1);

      const changed = {
        ...BEACON_PAGE_META,
        updatedAt: '2026-03-01T00:00:00Z',
      };
      await indexer.indexWiki([
        {
          page: changed,
          origin: 'beacon',
          content: '# Fragment guide\n\nRewritten body text.',
        },
      ]);

      expect(countWikiFtsRows(() => getDatabase())).toBe(1);
    });

    it('repairs a page that was embedded before the keyword index existed', async () => {
      const indexer = new WikiIndexer(makeProvider());
      const pages: WikiPageInput[] = [
        {
          page: BEACON_PAGE_META,
          origin: 'beacon',
          content: '# Fragment guide\n\nBeacon fragment details.',
        },
      ];
      await indexer.indexWiki(pages);

      // Simulate a pre-existing vector-only index: drop the FTS rows but keep
      // the source row and chunks, so the next pass takes the skip path.
      getDatabase().prepare('DELETE FROM wiki_fts').run();
      getDatabase().prepare('DELETE FROM wiki_fts_trigram').run();
      expect(
        hasWikiFtsRows(() => getDatabase(), 'fragments-guide', 'beacon')
      ).toBe(false);

      const second = await indexer.indexWiki(pages);
      expect(second.pagesSkipped).toBe(1);
      expect(second.pagesIndexed).toBe(0);
      expect(second.ftsRepaired).toBe(1);
      expect(
        hasWikiFtsRows(() => getDatabase(), 'fragments-guide', 'beacon')
      ).toBe(true);
    });

    it('does not re-embed when repairing the keyword index', async () => {
      const provider = makeProvider();
      const indexer = new WikiIndexer(provider);
      const pages: WikiPageInput[] = [
        {
          page: BEACON_PAGE_META,
          origin: 'beacon',
          content: '# Fragment guide\n\nBeacon fragment details.',
        },
      ];
      await indexer.indexWiki(pages);
      const callsAfterFirstPass = provider.calls.length;

      getDatabase().prepare('DELETE FROM wiki_fts').run();
      getDatabase().prepare('DELETE FROM wiki_fts_trigram').run();
      await indexer.indexWiki(pages);

      expect(provider.calls.length).toBe(callsAfterFirstPass);
    });
  });

  describe('index-pass query cost', () => {
    /** Runs `fn` with every prepared SQL statement recorded. */
    async function recordingSql(fn: () => Promise<void>): Promise<string[]> {
      const db = getDatabase();
      const original = db.prepare.bind(db);
      const seen: string[] = [];
      (db as unknown as { prepare: (sql: string) => unknown }).prepare = (
        sql: string
      ) => {
        seen.push(sql);
        return original(sql);
      };
      try {
        await fn();
      } finally {
        (db as unknown as { prepare: unknown }).prepare = original;
      }
      return seen;
    }

    function pageMeta(id: string) {
      return { ...BEACON_PAGE_META, id, title: `Page ${id}` };
    }

    it('aggregates stored chunk counts once per pass, not once per page', async () => {
      const indexer = new WikiIndexer(makeProvider());
      const pages: WikiPageInput[] = Array.from({ length: 5 }, (_, i) => ({
        page: pageMeta(`page-${i}`),
        origin: 'beacon' as const,
        content: `# Page ${i}\n\nBody text for page ${i}.`,
      }));

      const sql = await recordingSql(async () => {
        await indexer.indexWiki(pages);
      });

      // The aggregate LEFT JOINs every source against every chunk, so calling
      // it per page made a sweep O(pages²). One snapshot per pass is enough:
      // each (page_id, origin) is visited at most once.
      const aggregates = sql.filter(s => s.includes('COUNT(c.id)'));
      expect(aggregates).toHaveLength(1);
    });

    it('still skips unchanged pages after the snapshot refactor', async () => {
      const indexer = new WikiIndexer(makeProvider());
      const pages: WikiPageInput[] = [
        {
          page: pageMeta('stable'),
          origin: 'beacon',
          content: '# Stable\n\nUnchanged body.',
        },
      ];

      const first = await indexer.indexWiki(pages);
      expect(first.pagesIndexed).toBe(1);

      const second = await indexer.indexWiki(pages);
      expect(second.pagesSkipped).toBe(1);
      expect(second.pagesIndexed).toBe(0);
    });
  });
});
