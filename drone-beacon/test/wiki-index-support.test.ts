import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setupDb, teardownDb } from './setup.js';
import { listWikiSources, getWikiChunks } from '../src/db/index.js';
import { WikiIndexer } from '../src/wiki-indexer.js';
import { runWikiIndexCycle, setWikiIndexer } from '../src/wiki-index-support.js';
import { setKnowledgeBaseDir, writePage } from '../../drone-swarm-common/src/index.js';
import type { DroneEmbeddingProvider } from 'drone-core';

const proxyWikiToCoordinator = vi.fn();

vi.mock('../src/routes/context.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/routes/context.js')>();
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
    dimensions: 768,
    maxTokens: 8192,
    getEmbedding: async (text: string) =>
      fakeEmbedding(text.length % 768),
  };
}

const COORD_PAGE_META = {
  id: 'spawn-pipeline',
  title: 'Spawn Pipeline',
  scope: 'coordinator' as const,
  tags: ['spawn'],
  sources: ['session-9'],
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
          return { ...COORD_PAGE_META, content: '# Spawn pipeline\n\nCoordinator spawn details.' };
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
          return { ...COORD_PAGE_META, content: '# Spawn pipeline\n\nCoordinator spawn details.' };
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
    proxyWikiToCoordinator.mockImplementation(async (method: string, p: string) => {
      if (method === 'GET' && p === '/wiki') {
        return [COORD_PAGE_META];
      }
      if (method === 'GET' && p === '/wiki/spawn-pipeline') {
        return { ...COORD_PAGE_META, content: '# Spawn pipeline\n\nCoordinator spawn details.' };
      }
      return null;
    });

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
      sources.find(s => s.page_id === 'spawn-pipeline' && s.origin === 'coordinator')
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
});