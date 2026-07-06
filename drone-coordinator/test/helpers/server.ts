/**
 * Shared test harness for coordinator route tests.
 * Creates a Fastify app bound to a fresh temp DB + storage + wiki dir.
 *
 * NOTE: Wiki routes use dynamic import('drone-swarm-common/wiki-storage')
 * which vitest resolves to the source file via alias. Dynamic imports from
 * test files don't go through the alias, so we use the dist file path
 * to ensure we get the same module instance that the symlink resolves to.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../src/db/index.js';
import { initStorage } from '../../src/storage.js';
import { buildApp } from '../../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TestCtx {
  app: FastifyInstance;
  dir: string;
}

export async function makeApp(opts?: {
  getToken?: () => string | null;
}): Promise<TestCtx> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'drone-coord-routes-'));
  initDatabase(path.join(dir, 'test.db'));
  initStorage(dir);

  // Set up wiki directory using the dist file path
  // (same module instance the symlink resolves to)
  const wikiStoragePath = path.resolve(
    __dirname,
    '../../../drone-swarm-common/dist/wiki-storage.js'
  );
  const { setKnowledgeBaseDir } = await import(wikiStoragePath);
  setKnowledgeBaseDir(path.join(dir, 'knowledge-base'));

  const app = await buildApp(opts);
  await app.ready();
  return { app, dir };
}

export async function teardownApp(ctx: TestCtx): Promise<void> {
  await ctx.app.close();
  closeDatabase();
  await rm(ctx.dir, { recursive: true, force: true });
}
