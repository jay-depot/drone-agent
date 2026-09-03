import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setupDb, teardownDb } from './setup.js';
import { WikiIndexer } from '../src/wiki-indexer.js';
import {
  runWikiIndexCycle,
  setWikiIndexer,
} from '../src/wiki-index-support.js';
import {
  setKnowledgeBaseDir,
  writePage,
} from '../../drone-swarm-common/src/index.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';
import type { DroneEmbeddingProvider } from 'drone-core';

const proxyWikiToCoordinator = vi.fn();

vi.mock('../src/routes/context.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/routes/context.js')>();
  return {
    ...actual,
    proxyWikiToCoordinator: (...args: unknown[]) =>
      proxyWikiToCoordinator(...args),
  };
});

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

/** Deterministic keyword-based embedder for both document and query sides. */
function makeProvider(): DroneEmbeddingProvider {
  return {
    id: 'fake',
    name: 'Fake Embedder',
    dimensions: 768,
    maxTokens: 8192,
    getEmbedding: async (text: string) => {
      const lowered = text.toLowerCase();
      for (const kw of ['fragment', 'persona', 'spawn']) {
        if (lowered.includes(kw)) return fakeEmbedding(keywordToIndex(kw));
      }
      return fakeEmbedding(keywordToIndex('unmatched'));
    },
  };
}

describe('GET /wiki/semantic-search', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await setupDb();
    const kbDir = await mkdtemp(path.join(os.tmpdir(), 'wiki-kb-search-'));
    setKnowledgeBaseDir(kbDir);
    proxyWikiToCoordinator.mockReset();
    setWikiIndexer(new WikiIndexer(makeProvider()));
    app = await buildTestApp();
  });

  afterEach(async () => {
    setWikiIndexer(undefined);
    await app.close();
    await teardownDb();
  });

  it('returns the best page with origin, title, and matched chunk', async () => {
    await writePage(
      'fragment-guide',
      'Fragment Guide',
      'beacon',
      '# Fragments\n\nHow the fragment TTL sweep works on the beacon.'
    );
    const indexer = new WikiIndexer(makeProvider());
    setWikiIndexer(indexer);
    await runWikiIndexCycle(indexer);

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/semantic-search?q=fragment%20ttl%20sweep',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.resultCount).toBeGreaterThanOrEqual(1);
    const top = body.results[0];
    expect(top.pageId).toBe('fragment-guide');
    expect(top.origin).toBe('beacon');
    expect(top.title).toBe('Fragment Guide');
    expect(top.matchedChunk).toContain('fragment');
  });

  it('applies minScore filtering', async () => {
    await writePage(
      'fragment-guide',
      'Fragment Guide',
      'beacon',
      '# Fragments\n\nHow the fragment TTL sweep works on the beacon.'
    );
    const indexer = new WikiIndexer(makeProvider());
    setWikiIndexer(indexer);
    await runWikiIndexCycle(indexer);

    const strict = await app.inject({
      method: 'GET',
      url: '/wiki/semantic-search?q=fragment&minScore=0.99',
    });
    const body = JSON.parse(strict.body);
    for (const r of body.results) {
      expect(r.score).toBeGreaterThanOrEqual(0.99);
    }
  });

  it('returns distinct entries for the same pageId on different origins', async () => {
    proxyWikiToCoordinator.mockImplementation(async (_m: string, p: string) => {
      if (p === '/wiki') {
        return [
          {
            id: 'fragment-guide',
            title: 'Fragment Guide (Coordinator)',
            scope: 'coordinator',
            tags: ['fragments'],
            sources: ['s1'],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-05T00:00:00Z',
          },
        ];
      }
      if (p === '/wiki/fragment-guide') {
        return {
          id: 'fragment-guide',
          title: 'Fragment Guide (Coordinator)',
          scope: 'coordinator',
          content: '# Fragments\n\nCoordinator fragment lifecycle rules.',
        };
      }
      return null;
    });

    await writePage(
      'fragment-guide',
      'Fragment Guide',
      'beacon',
      '# Fragments\n\nBeacon fragment sweep details.'
    );
    const indexer = new WikiIndexer(makeProvider());
    setWikiIndexer(indexer);
    await runWikiIndexCycle(indexer);

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/semantic-search?q=fragment',
    });
    const body = JSON.parse(res.body);
    const origins = body.results
      .filter((r: { pageId: string }) => r.pageId === 'fragment-guide')
      .map((r: { origin: string }) => r.origin)
      .sort();
    expect(origins).toEqual(['beacon', 'coordinator']);
  });

  it('filters by origin when requested', async () => {
    proxyWikiToCoordinator.mockImplementation(async (_m: string, p: string) => {
      if (p === '/wiki') {
        return [
          {
            id: 'spawn-pipeline',
            title: 'Spawn Pipeline',
            scope: 'coordinator',
            tags: ['spawn'],
            sources: ['s2'],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-05T00:00:00Z',
          },
        ];
      }
      if (p === '/wiki/spawn-pipeline') {
        return {
          id: 'spawn-pipeline',
          title: 'Spawn Pipeline',
          scope: 'coordinator',
          content: '# Spawn\n\nCoordinator spawn flow.',
        };
      }
      return null;
    });
    await writePage(
      'fragment-guide',
      'Fragment Guide',
      'beacon',
      '# Fragments\n\nBeacon fragment sweep details.'
    );
    const indexer = new WikiIndexer(makeProvider());
    setWikiIndexer(indexer);
    await runWikiIndexCycle(indexer);

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/semantic-search?q=fragment&origin=coordinator',
    });
    const body = JSON.parse(res.body);
    for (const r of body.results) {
      expect(r.origin).toBe('coordinator');
    }
  });

  it('returns 400 without q and 503 without an embedding provider', async () => {
    const noQ = await app.inject({
      method: 'GET',
      url: '/wiki/semantic-search',
    });
    expect(noQ.statusCode).toBe(400);

    setWikiIndexer(undefined);
    const res = await app.inject({
      method: 'GET',
      url: '/wiki/semantic-search?q=anything',
    });
    expect(res.statusCode).toBe(503);
  });
});
