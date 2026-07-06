import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase } from '../src/db.js';
import { initStorage } from '../src/storage.js';

let dbPath = '';

export async function setupDb(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'drone-coordinator-test-'));
  const dbFile = path.join(dir, 'test.db');
  initDatabase(dbFile);
  initStorage(dir);
  dbPath = dbFile;
  return dbFile;
}

export async function teardownDb(): Promise<void> {
  closeDatabase();
  if (dbPath) {
    await rm(path.dirname(dbPath), { recursive: true, force: true });
  }
  dbPath = '';
}
