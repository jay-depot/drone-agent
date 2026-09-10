import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { setupDb, teardownDb } from './setup.js';
import {
  setKnowledgeBaseDir,
  writePage,
} from '../../drone-swarm-common/src/index.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';

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
    mockCoordinatorWithDualPage();

    const res = await app.inject({
      method: 'GET',
      url: '/wiki/search?q=dual',
    });
    const search = JSON.parse(res.body) as Array<{ origin?: string }>;
    const origins = search.map(r => String(r.origin)).sort();
    expect(origins).toEqual(['beacon', 'coordinator']);
  });
});

describe('wiki delete scope semantics', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await setupDb();
    const kbDir = await mkdtemp(path.join(os.tmpdir(), 'wiki-kb-del-'));
    setKnowledgeBaseDir(kbDir);
    proxyWikiToCoordinator.mockReset();
    triggerWikiReindex.mockReset();
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    await teardownDb();
  });

  function mockCoordinatorDelete(outcome: 'ok' | 'not-found'): void {
    proxyWikiToCoordinator.mockImplementation(async (method: string) => {
      if (method === 'DELETE') {
        return outcome === 'ok' ? { success: true } : null;
      }
      return null;
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
    expect(proxyWikiToCoordinator).not.toHaveBeenCalled();
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
    expect(proxyWikiToCoordinator).toHaveBeenCalledWith(
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
});
