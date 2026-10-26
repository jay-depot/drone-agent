import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setupDb, teardownDb } from './setup.js';
import { listWikiSources, getWikiChunks } from '../src/db/index.js';
import { WikiIndexer } from '../src/wiki-indexer.js';
import {
  runWikiIndexCycle,
  setWikiIndexer,
  setWikiReindexDebounceMs,
  triggerWikiReindex,
} from '../src/wiki-index-support.js';
import {
  setKnowledgeBaseDir,
  writePage,
} from '../../drone-swarm-common/src/index.js';
import { NOMIC_EMBED_TEXT_V1_5, type DroneEmbeddingProvider } from 'drone-core';

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

function makeProvider(): DroneEmbeddingProvider {
  return {
    id: 'fake',
    name: 'Fake Embedder',
    spec: NOMIC_EMBED_TEXT_V1_5,
    dimensions: 768,
    maxTokens: 8192,
    getEmbedding: async (text: string) => fakeEmbedding(text.length % 768),
    embedQuery: async (text: string) => fakeEmbedding(text.length % 768),
    embedDocument: async (text: string) => fakeEmbedding(text.length % 768),
  };
}

const COORD_PAGE_META = {
  id: 'spawn-pipeline',
  title: 'Spawn Pipeline',
  scope: 'coordinator' as const,
  tags: ['spawn'],
  sources: ['session-9'],
  wordCount: 0,
  linkCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
};

async function seedLocalPage(): Promise<void> {
  await writePage(
    'local-notes',
    'Local Notes',
    'beacon',
    '# Local notes\n\nBeacon-side details for local operation.'
  );
}

describe('wiki index cycle (S3 wiring)', () => {
  beforeEach(async () => {
    await setupDb();
    const kbDir = await mkdtemp(path.join(os.tmpdir(), 'wiki-kb-cycle-'));
    setKnowledgeBaseDir(kbDir);
    proxyWikiToCoordinator.mockReset();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('indexes coordinator pages via lazy per-page fetch through the proxy', async () => {
    proxyWikiToCoordinator.mockImplementation(
      async (method: string, p: string) => {
        if (method === 'GET' && p === '/wiki') {
          return [COORD_PAGE_META];
        }
        if (method === 'GET' && p === '/wiki/spawn-pipeline') {
          return {
            ...COORD_PAGE_META,
            content: '# Spawn pipeline\n\nCoordinator spawn details.',
          };
        }
        return null;
      }
    );

    const indexer = new WikiIndexer(makeProvider());
    const result = await runWikiIndexCycle(indexer);

    expect(result?.pagesIndexed).toBe(1);
    expect(listWikiSources().map(s => s.origin)).toEqual(['coordinator']);
    expect(
      getWikiChunks('spawn-pipeline', 'coordinator')
        .map(c => c.text)
        .join('\n')
    ).toContain('Coordinator spawn details.');
  });

  it('deletes coordinator-origin index rows after the coordinator page list loses them', async () => {
    proxyWikiToCoordinator.mockImplementation(
      async (method: string, p: string) => {
        if (method === 'GET' && p === '/wiki') {
          return [COORD_PAGE_META];
        }
        if (method === 'GET' && p === '/wiki/spawn-pipeline') {
          return {
            ...COORD_PAGE_META,
            content: '# Spawn pipeline\n\nCoordinator spawn details.',
          };
        }
        return null;
      }
    );

    const indexer = new WikiIndexer(makeProvider());
    await runWikiIndexCycle(indexer);
    expect(listWikiSources()).toHaveLength(1);

    // Coordinator now reports an empty page list (page deleted there).
    proxyWikiToCoordinator.mockImplementation(async (method: string) =>
      method === 'GET' ? [] : null
    );
    const second = await runWikiIndexCycle(indexer);

    expect(second?.pagesRemoved).toBe(1);
    expect(listWikiSources()).toHaveLength(0);
  });

  it('never wipes coordinator-origin rows when the coordinator is unreachable', async () => {
    proxyWikiToCoordinator.mockImplementation(
      async (method: string, p: string) => {
        if (method === 'GET' && p === '/wiki') {
          return [COORD_PAGE_META];
        }
        if (method === 'GET' && p === '/wiki/spawn-pipeline') {
          return {
            ...COORD_PAGE_META,
            content: '# Spawn pipeline\n\nCoordinator spawn details.',
          };
        }
        return null;
      }
    );

    const indexer = new WikiIndexer(makeProvider());
    await runWikiIndexCycle(indexer);
    expect(listWikiSources()).toHaveLength(1);

    // Coordinator goes down: fetch throws (and locally a new page appears).
    proxyWikiToCoordinator.mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    await seedLocalPage();
    const second = await runWikiIndexCycle(indexer);

    expect(second?.pagesRemoved).toBe(0);
    const sources = listWikiSources();
    expect(
      sources.find(
        s => s.page_id === 'spawn-pipeline' && s.origin === 'coordinator'
      )
    ).toBeDefined();
  });

  it('POST /wiki/reindex runs a guarded cycle and reports results', async () => {
    const { buildTestApp } = await import('./app-helper.js');

    proxyWikiToCoordinator.mockImplementation(async () => null);
    const indexer = new WikiIndexer(makeProvider());
    setWikiIndexer(indexer);

    try {
      const app = await buildTestApp();
      try {
        await seedLocalPage();
        const res = await app.inject({ method: 'POST', url: '/wiki/reindex' });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.result.pagesIndexed).toBe(1);
      } finally {
        await app.close();
      }
    } finally {
      setWikiIndexer(undefined);
    }
  });

  it('coalesces a burst of writes into a single reindex cycle', async () => {
    vi.useFakeTimers();
    try {
      proxyWikiToCoordinator.mockImplementation(async () => null);
      const indexer = new WikiIndexer(makeProvider());
      setWikiIndexer(indexer);
      setWikiReindexDebounceMs(5000);
      const runCycle = vi.spyOn(indexer, 'runCycle');

      triggerWikiReindex();
      triggerWikiReindex();
      triggerWikiReindex();
      expect(runCycle).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(runCycle).toHaveBeenCalledTimes(1);
    } finally {
      setWikiIndexer(undefined);
      vi.useRealTimers();
    }
  });

  it('re-arms the debounced reindex when a cycle is skipped', async () => {
    vi.useFakeTimers();
    try {
      const indexer = new WikiIndexer(makeProvider());
      setWikiIndexer(indexer);
      setWikiReindexDebounceMs(5000);
      // First cycle is skipped (a periodic sweep holds the in-flight guard);
      // the second succeeds once that sweep has finished.
      const runCycle = vi
        .spyOn(indexer, 'runCycle')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          pagesIndexed: 0,
          pagesSkipped: 0,
          pagesRemoved: 0,
          chunksCreated: 0,
          ftsRepaired: 0,
        });

      triggerWikiReindex();
      await vi.advanceTimersByTimeAsync(5000);
      expect(runCycle).toHaveBeenCalledTimes(1);

      // The skipped write is retried through the same debounce delay.
      await vi.advanceTimersByTimeAsync(5000);
      expect(runCycle).toHaveBeenCalledTimes(2);

      // A successful cycle does not re-arm: no tight loop.
      await vi.advanceTimersByTimeAsync(5000);
      expect(runCycle).toHaveBeenCalledTimes(2);
    } finally {
      setWikiIndexer(undefined);
      vi.useRealTimers();
    }
  });
});
