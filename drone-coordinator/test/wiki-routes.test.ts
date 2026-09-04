import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupDb, teardownDb } from './setup.js';
import { setKnowledgeBaseDir } from '../../drone-swarm-common/src/index.js';
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
});