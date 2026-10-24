import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setupDb, teardownDb } from './setup.js';
import {
  replaceWikiFtsRows,
  setKnowledgeBaseDir,
  writePage,
} from '../../drone-swarm-common/src/index.js';
import { getDatabase } from '../src/db/index.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';

const proxyWikiToCoordinator = vi.fn();
const proxyToCoordinatorDetailed = vi.fn();

vi.mock('../src/routes/context.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/routes/context.js')>();
  return {
    ...actual,
    proxyWikiToCoordinator: (...args: unknown[]) =>
      proxyWikiToCoordinator(...args),
    proxyToCoordinatorDetailed: (...args: unknown[]) =>
      proxyToCoordinatorDetailed(...args),
  };
});

const triggerWikiReindex = vi.fn();

vi.mock('../src/wiki-index-support.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/wiki-index-support.js')>();
  return {
    ...actual,
    triggerWikiReindex: () => triggerWikiReindex(),
  };
});

const COORD_VERSION = {
  id: 'dual-page',
  title: 'Dual Page (Coordinator)',
  scope: 'coordinator',
  tags: ['dual'],
  sources: ['s1'],
  wordCount: 0,
  linkCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

function mockCoordinatorWithDualPage(): void {
  proxyWikiToCoordinator.mockImplementation(
    async (method: string, p: string) => {
      if (method === 'GET' && p === '/wiki') {
        return [COORD_VERSION];
      }
      if (method === 'GET' && p === '/wiki/dual-page') {
        return { ...COORD_VERSION, content: '# Dual\n\nCoordinator body.' };
      }
      if (method === 'GET' && p.startsWith('/wiki/search')) {
        return [
          {
            page: COORD_VERSION,
            snippet: 'dual',
            score: 0.9,
            origin: 'coordinator',
          },
        ];
      }
      return null;
    }
  );
}

describe('origin-tagged wiki reads (S6)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await setupDb();
    const kbDir = await mkdtemp(path.join(os.tmpdir(), 'wiki-kb-orig-'));
    setKnowledgeBaseDir(kbDir);
    proxyWikiToCoordinator.mockReset();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    await teardownDb();
  });

  it('no-scope read returns ALL versions tagged by origin', async () => {
    await writePage(
      'dual-page',
      'Dual Page',
      'beacon',
      '# Dual\n\nBeacon body.'
    );
    mockCoordinatorWithDualPage();

    const res = await app.inject({ method: 'GET', url: '/wiki/dual-page' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pageId).toBe('dual-page');
    expect(body.versions).toHaveLength(2);
    const origins = body.versions
      .map((v: { origin: string }) => v.origin)
      .sort();
    expect(origins).toEqual(['beacon', 'coordinator']);
  });

  it('PUT accepts an optional pitch and round-trips it through the local store', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/wiki/pitch-page',
      payload: {
        title: 'Pitch Page',
        content: '# Pitch\n\nBody.',
        scope: 'beacon',
        tags: ['pitch'],
        sources: ['s1'],
        pitch: 'A one-sentence pitch.',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pitch).toBe('A one-sentence pitch.');
    expect(body.title).toBe('Pitch Page');

    // Read back through the store
    const read = await app.inject({
      method: 'GET',
      url: '/wiki/pitch-page?scope=beacon',
    });
    expect(read.statusCode).toBe(200);
    expect(JSON.parse(read.body).pitch).toBe('A one-sentence pitch.');
  });

  it('PUT without a pitch stores the page without one', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/wiki/no-pitch-page',
      payload: {
        title: 'No Pitch',
        content: 'Body.',
        scope: 'beacon',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pitch).toBeUndefined();

    const read = await app.inject({
      method: 'GET',
      url: '/wiki/no-pitch-page?scope=beacon',
    });
    expect(JSON.parse(read.body).pitch).toBeUndefined();
  });

  it('no-scope read returns a single beacon version when the coordinator lacks the page', async () => {
    await writePage('solo-page', 'Solo', 'beacon', '# Solo\n\nOnly here.');
    proxyWikiToCoordinator.mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: '/wiki/solo-page' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].origin).toBe('beacon');
  });

  it('no-scope read 404s only when no version exists anywhere', async () => {
    proxyWikiToCoordinator.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/wiki/missing' });
    expect(res.statusCode).toBe(404);
  });

  it('?scope=beacon returns exactly the local version', async () => {
    await writePage(
      'dual-page',
      'Dual Page',
      'beacon',
      '# Dual\n\nBeacon body.'
    );
    mockCoordinatorWithDualPage();

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/dual-page?scope=beacon',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.origin).toBe('beacon');
    expect(body.content).toContain('Beacon body');
  });

  it('?scope=coordinator returns exactly the coordinator version', async () => {
    mockCoordinatorWithDualPage();
    const res = await app.inject({
      method: 'GET',
      url: '/wiki/dual-page?scope=coordinator',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.origin).toBe('coordinator');
  });

  it('list results carry origin tags for both versions', async () => {
    await writePage(
      'dual-page',
      'Dual Page',
      'beacon',
      '# Dual\n\nBeacon body.'
    );
    mockCoordinatorWithDualPage();

    const res = await app.inject({ method: 'GET', url: '/wiki' });
    const list = JSON.parse(res.body) as Array<Record<string, unknown>>;
    const origins = list
      .filter(p => p.id === 'dual-page')
      .map(p => String(p.origin))
      .sort();
    expect(origins).toEqual(['beacon', 'coordinator']);
  });

  it('keyword search results carry origin tags for both sides', async () => {
    await writePage(
      'dual-page',
      'Dual Page',
      'beacon',
      '# Dual\n\nBeacon body.'
    );
    // The keyword route reads the FTS index. In production the post-write
    // reindex hook populates it; that hook is mocked in this file, so seed
    // the index directly.
    replaceWikiFtsRows(() => getDatabase(), {
      pageId: 'dual-page',
      origin: 'beacon',
      title: 'Dual Page',
      tags: 'dual',
      body: '# Dual\n\nBeacon body.',
    });
    mockCoordinatorWithDualPage();

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/search?q=dual',
    });
    const search = JSON.parse(res.body) as Array<{ origin?: string }>;
    const origins = search.map(r => String(r.origin)).sort();
    expect(origins).toEqual(['beacon', 'coordinator']);
  });

  it('keyword search finds a page by a literal id fragment', async () => {
    const id = 'drone-beacon-wiki-reindex-duplicate-chunks';
    await writePage(
      id,
      'Reindex duplicated chunks',
      'beacon',
      '# Reindex\n\nBody.'
    );
    replaceWikiFtsRows(() => getDatabase(), {
      pageId: id,
      origin: 'beacon',
      title: 'Reindex duplicated chunks',
      tags: 'drone-beacon',
      body: '# Reindex\n\nBody.',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/search?q=reindex-duplicate',
    });
    const search = JSON.parse(res.body) as Array<{ page?: { id?: string } }>;
    expect(search.map(r => r.page?.id)).toContain(id);
  });

  it('keyword search finds a commit hash that stemming would destroy', async () => {
    await writePage('commit-page', 'Fix 5e313af9', 'beacon', 'See 5e313af9.');
    replaceWikiFtsRows(() => getDatabase(), {
      pageId: 'commit-page',
      origin: 'beacon',
      title: 'Fix 5e313af9',
      tags: '',
      body: 'See 5e313af9.',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/search?q=5e313af9',
    });
    const search = JSON.parse(res.body) as Array<{ page?: { id?: string } }>;
    expect(search.map(r => r.page?.id)).toEqual(['commit-page']);
  });

  it('keyword search returns a snippet and no page body', async () => {
    await writePage(
      'snippet-page',
      'Snippet Page',
      'beacon',
      '# Snippet\n\nThe changed-content path inserted chunks with no delete.'
    );
    replaceWikiFtsRows(() => getDatabase(), {
      pageId: 'snippet-page',
      origin: 'beacon',
      title: 'Snippet Page',
      tags: '',
      body: '# Snippet\n\nThe changed-content path inserted chunks with no delete.',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/search?q=delete',
    });
    const search = JSON.parse(res.body) as Array<{
      page?: Record<string, unknown>;
      snippet?: string;
    }>;
    expect(search).toHaveLength(1);
    expect(search[0].page?.content).toBeUndefined();
    expect(typeof search[0].snippet).toBe('string');
  });

  it('keyword search returns [] for an empty query without hitting the index', async () => {
    const res = await app.inject({ method: 'GET', url: '/wiki/search?q=' });
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('keyword search returns [] when nothing matches', async () => {
    await writePage('unrelated', 'Unrelated', 'beacon', 'Sourdough notes.');
    replaceWikiFtsRows(() => getDatabase(), {
      pageId: 'unrelated',
      origin: 'beacon',
      title: 'Unrelated',
      tags: '',
      body: 'Sourdough notes.',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/search?q=zzqqxxnosuchtoken',
    });
    const search = JSON.parse(res.body) as Array<{ origin?: string }>;
    expect(search.filter(r => r.origin === 'beacon')).toEqual([]);
  });
});

describe('wiki delete scope semantics', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await setupDb();
    const kbDir = await mkdtemp(path.join(os.tmpdir(), 'wiki-kb-del-'));
    setKnowledgeBaseDir(kbDir);
    proxyWikiToCoordinator.mockReset();
    proxyToCoordinatorDetailed.mockReset();
    triggerWikiReindex.mockReset();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    await teardownDb();
  });

  function mockCoordinatorDelete(outcome: 'ok' | 'not-found'): void {
    proxyToCoordinatorDetailed.mockImplementation(async (method: string) => {
      if (method !== 'DELETE') {
        return { responded: false };
      }
      return outcome === 'ok'
        ? { responded: true, status: 200, body: { success: true } }
        : {
            responded: true,
            status: 404,
            body: { error: 'Wiki page not found' },
          };
    });
  }

  it('scope=coordinator delete succeeds and triggers a reindex', async () => {
    mockCoordinatorDelete('ok');
    const res = await app.inject({
      method: 'DELETE',
      url: '/wiki/dual-page?scope=coordinator',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(triggerWikiReindex).toHaveBeenCalledTimes(1);
  });

  it('scope=coordinator delete of an absent coordinator page 404s without a reindex', async () => {
    mockCoordinatorDelete('not-found');
    const res = await app.inject({
      method: 'DELETE',
      url: '/wiki/missing-page?scope=coordinator',
    });
    expect(res.statusCode).toBe(404);
    expect(triggerWikiReindex).not.toHaveBeenCalled();
  });

  it('scope=beacon delete removes only the local page', async () => {
    await writePage('beacon-only', 'Beacon Only', 'beacon', '# B');
    mockCoordinatorDelete('ok');
    const res = await app.inject({
      method: 'DELETE',
      url: '/wiki/beacon-only?scope=beacon',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ success: true });
    expect(proxyToCoordinatorDetailed).not.toHaveBeenCalled();
    expect(triggerWikiReindex).toHaveBeenCalledTimes(1);
  });

  it('no-scope delete removes both versions of a dual-scope page', async () => {
    await writePage('dual-page', 'Dual', 'beacon', '# Dual\n\nLocal.');
    mockCoordinatorDelete('ok');
    const res = await app.inject({ method: 'DELETE', url: '/wiki/dual-page' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      beaconDeleted: true,
      coordinatorDeleted: true,
    });
    expect(proxyToCoordinatorDetailed).toHaveBeenCalledWith(
      'DELETE',
      '/wiki/dual-page'
    );
    expect(triggerWikiReindex).toHaveBeenCalledTimes(1);
  });

  it('no-scope delete of a beacon-only page still attempts the coordinator', async () => {
    await writePage('beacon-only', 'Beacon Only', 'beacon', '# B');
    mockCoordinatorDelete('not-found');
    const res = await app.inject({
      method: 'DELETE',
      url: '/wiki/beacon-only',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      beaconDeleted: true,
      coordinatorDeleted: false,
    });
    expect(triggerWikiReindex).toHaveBeenCalledTimes(1);
  });

  it('no-scope delete of a coordinator-only page succeeds', async () => {
    mockCoordinatorDelete('ok');
    const res = await app.inject({
      method: 'DELETE',
      url: '/wiki/coord-only',
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      beaconDeleted: false,
      coordinatorDeleted: true,
    });
    expect(triggerWikiReindex).toHaveBeenCalledTimes(1);
  });

  it('no-scope delete 404s when the page exists nowhere', async () => {
    mockCoordinatorDelete('not-found');
    const res = await app.inject({
      method: 'DELETE',
      url: '/wiki/missing-page',
    });
    expect(res.statusCode).toBe(404);
    expect(triggerWikiReindex).not.toHaveBeenCalled();
  });

  it('falls back to { error } for a non-JSON coordinator error body', async () => {
    proxyToCoordinatorDetailed.mockResolvedValue({
      responded: true,
      status: 500,
      body: { error: '<html>boom</html>' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/wiki/dual-page?scope=coordinator',
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: '<html>boom</html>' });
  });

  it('no-scope delete keeps the partial result when the coordinator errors but the local page was deleted', async () => {
    await writePage('dual-page', 'Dual', 'beacon', '# Dual\n\nLocal.');
    proxyToCoordinatorDetailed.mockResolvedValue({
      responded: true,
      status: 500,
      body: { error: 'coordinator exploded' },
    });
    const res = await app.inject({ method: 'DELETE', url: '/wiki/dual-page' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      success: true,
      beaconDeleted: true,
      coordinatorDeleted: false,
    });
    expect(triggerWikiReindex).toHaveBeenCalledTimes(1);
  });

  it('no-scope delete forwards the coordinator error when nothing was deleted', async () => {
    proxyToCoordinatorDetailed.mockResolvedValue({
      responded: true,
      status: 500,
      body: { error: 'coordinator exploded' },
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/wiki/missing-page',
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: 'coordinator exploded' });
    expect(triggerWikiReindex).not.toHaveBeenCalled();
  });

  it('no-scope delete returns the generic 502 when the coordinator is unreachable and nothing was deleted', async () => {
    proxyToCoordinatorDetailed.mockResolvedValue({ responded: false });
    const res = await app.inject({
      method: 'DELETE',
      url: '/wiki/missing-page',
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({
      error: 'Failed to proxy to coordinator',
    });
    expect(triggerWikiReindex).not.toHaveBeenCalled();
  });
});

describe('wiki agent read count accounting', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await setupDb();
    const kbDir = await mkdtemp(path.join(os.tmpdir(), 'wiki-kb-count-'));
    setKnowledgeBaseDir(kbDir);
    proxyWikiToCoordinator.mockReset();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    await teardownDb();
  });

  function readCountCalls(): unknown[][] {
    return proxyWikiToCoordinator.mock.calls.filter(
      ([method]) => method === 'POST'
    );
  }

  it('?scope=coordinator read bumps the coordinator read count', async () => {
    mockCoordinatorWithDualPage();
    const res = await app.inject({
      method: 'GET',
      url: '/wiki/dual-page?scope=coordinator',
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(proxyWikiToCoordinator).toHaveBeenCalledWith(
        'POST',
        '/wiki/dual-page/read'
      );
    });
  });

  it('no-scope read bumps the count exactly once when a coordinator version exists', async () => {
    await writePage(
      'dual-page',
      'Dual Page',
      'beacon',
      '# Dual\n\nBeacon body.'
    );
    mockCoordinatorWithDualPage();

    const res = await app.inject({ method: 'GET', url: '/wiki/dual-page' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.versions).toHaveLength(2);

    await vi.waitFor(() => {
      expect(readCountCalls()).toHaveLength(1);
    });
    expect(readCountCalls()[0]).toEqual(['POST', '/wiki/dual-page/read']);
  });

  it('no-scope read does not bump when only a beacon version exists', async () => {
    await writePage('solo-page', 'Solo', 'beacon', '# Solo\n\nOnly here.');
    proxyWikiToCoordinator.mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: '/wiki/solo-page' });
    expect(res.statusCode).toBe(200);
    expect(readCountCalls()).toHaveLength(0);
  });

  it('?scope=beacon read does not bump any count', async () => {
    await writePage(
      'dual-page',
      'Dual Page',
      'beacon',
      '# Dual\n\nBeacon body.'
    );
    mockCoordinatorWithDualPage();

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/dual-page?scope=beacon',
    });
    expect(res.statusCode).toBe(200);
    expect(readCountCalls()).toHaveLength(0);
  });

  it('list and keyword search do not bump any count', async () => {
    await writePage(
      'dual-page',
      'Dual Page',
      'beacon',
      '# Dual\n\nBeacon body.'
    );
    mockCoordinatorWithDualPage();

    await app.inject({ method: 'GET', url: '/wiki' });
    await app.inject({ method: 'GET', url: '/wiki/search?q=dual' });

    expect(readCountCalls()).toHaveLength(0);
  });
});
