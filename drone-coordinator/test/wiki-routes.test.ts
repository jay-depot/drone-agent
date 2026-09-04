import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupDb, teardownDb } from './setup.js';
import {
  setKnowledgeBaseDir,
  writePage,
} from '../../drone-swarm-common/src/index.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';

describe('coordinator wiki routes', () => {
  let app: FastifyInstance;
  let kbDir: string;

  beforeEach(async () => {
    await setupDb();
    kbDir = await mkdtemp(path.join(os.tmpdir(), 'coord-wiki-routes-'));
    setKnowledgeBaseDir(kbDir);
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
    await teardownDb();
    await rm(kbDir, { recursive: true, force: true });
  });

  it('PUT accepts an optional pitch and round-trips it', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/wiki/pitch-page',
      payload: {
        title: 'Pitch Page',
        content: '# Pitch\n\nCoordinator body.',
        scope: 'coordinator',
        tags: ['pitch'],
        sources: ['s1'],
        pitch: 'A one-sentence pitch.',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pitch).toBe('A one-sentence pitch.');
    expect(body.scope).toBe('coordinator');

    const read = await app.inject({
      method: 'GET',
      url: '/api/wiki/pitch-page',
    });
    expect(read.statusCode).toBe(200);
    expect(JSON.parse(read.body).pitch).toBe('A one-sentence pitch.');
  });

  it('PUT without a pitch stores the page without one', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/wiki/no-pitch-page',
      payload: {
        title: 'No Pitch',
        content: 'Body.',
        scope: 'coordinator',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.pitch).toBeUndefined();

    const read = await app.inject({
      method: 'GET',
      url: '/api/wiki/no-pitch-page',
    });
    expect(JSON.parse(read.body).pitch).toBeUndefined();
  });

  it('GET /api/wiki/graph returns nodes and edges from the coordinator store', async () => {
    await writePage(
      'page-a',
      'Page A',
      'coordinator',
      'See [[page-b]] and [[missing-page]].',
      ['tagA']
    );
    await writePage('page-b', 'Page B', 'coordinator', 'Body');
    await writePage('orphan', 'Orphan', 'coordinator', 'Body');

    const res = await app.inject({
      method: 'GET',
      url: '/api/wiki/graph',
    });
    expect(res.statusCode).toBe(200);
    const graph = JSON.parse(res.body);
    const ids = graph.nodes.map((n: { id: string }) => n.id).sort();
    // page-a, page-b, orphan, plus the exists:false placeholder for missing-page
    expect(ids).toEqual(['missing-page', 'orphan', 'page-a', 'page-b']);

    const missing = graph.nodes.find(
      (n: { id: string }) => n.id === 'missing-page'
    );
    expect(missing).toBeDefined();
    expect(missing.exists).toBe(false);

    expect(graph.edges).toContainEqual({
      source: 'page-a',
      target: 'page-b',
      kind: 'link',
    });
    expect(graph.edges).toContainEqual({
      source: 'page-a',
      target: 'missing-page',
      kind: 'link',
    });
  });
});
