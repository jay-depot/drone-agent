/**
 * Shared test harness for coordinator route tests.
 * Creates a Fastify app bound to a fresh temp DB + storage + wiki dir.
 *
 * NOTE: Wiki routes use dynamic import('drone-swarm-common') which vitest
 * resolves to the source file via the workspace alias. The helper imports
 * the same module so setKnowledgeBaseDir targets the same module instance
 * the routes read from.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../src/db/index.js';
import { initStorage } from '../../src/storage.js';
import { buildTestApp } from '../app-helper.js';
import { setKnowledgeBaseDir } from 'drone-swarm-common';

export interface TestCtx {
  app: FastifyInstance;
  dir: string;
}

export async function makeApp(): Promise<TestCtx> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'drone-coord-routes-'));
  initDatabase(path.join(dir, 'test.db'));
  initStorage(dir);

  // Point the wiki storage at a fresh knowledge-base dir under the temp dir.
  setKnowledgeBaseDir(path.join(dir, 'knowledge-base'));

  const app = await buildTestApp();
  await app.ready();
  return { app, dir };
}

export async function teardownApp(ctx: TestCtx): Promise<void> {
  await ctx.app.close();
  closeDatabase();
  await rm(ctx.dir, { recursive: true, force: true });
}
