import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initDatabase,
  closeDatabase,
  incrementWikiReadCount,
  getWikiReadCount,
  getWikiReadCounts,
  deleteWikiPageMetadata,
} from '../src/db/index.js';

let dbPath = '';

async function setupDb(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'drone-coordinator-wiki-'));
  const dbFile = path.join(dir, 'test.db');
  initDatabase(dbFile);
  return dbFile;
}

afterEach(async () => {
  closeDatabase();
  if (dbPath) {
    await rm(path.dirname(dbPath), { recursive: true, force: true });
  }
  dbPath = '';
});

describe('Wiki page metadata read counts', () => {
  beforeEach(async () => {
    dbPath = await setupDb();
  });

  it('increments from zero, creating the row on first read', () => {
    expect(getWikiReadCount('fresh-page')).toBe(0);
    expect(incrementWikiReadCount('fresh-page')).toBe(1);
    expect(getWikiReadCount('fresh-page')).toBe(1);
  });

  it('increments cumulatively on repeated reads', () => {
    incrementWikiReadCount('page-a');
    expect(incrementWikiReadCount('page-a')).toBe(2);
    expect(incrementWikiReadCount('page-a')).toBe(3);
    expect(getWikiReadCount('page-a')).toBe(3);
  });

  it('counts pages independently', () => {
    incrementWikiReadCount('page-a');
    incrementWikiReadCount('page-b');
    incrementWikiReadCount('page-b');

    expect(getWikiReadCount('page-a')).toBe(1);
    expect(getWikiReadCount('page-b')).toBe(2);
  });

  it('returns a map of all read counts', () => {
    incrementWikiReadCount('page-a');
    incrementWikiReadCount('page-b');
    incrementWikiReadCount('page-b');

    const counts = getWikiReadCounts();
    expect(counts.size).toBe(2);
    expect(counts.get('page-a')).toBe(1);
    expect(counts.get('page-b')).toBe(2);
  });

  it('returns an empty map before any reads', () => {
    expect(getWikiReadCounts().size).toBe(0);
  });

  it('deletes the metadata row and resets the count to zero', () => {
    incrementWikiReadCount('page-a');
    incrementWikiReadCount('page-a');
    expect(getWikiReadCount('page-a')).toBe(2);

    const deleted = deleteWikiPageMetadata('page-a');
    expect(deleted).toBe(true);
    expect(getWikiReadCount('page-a')).toBe(0);
  });

  it('returns false when deleting a page with no metadata row', () => {
    expect(deleteWikiPageMetadata('never-read')).toBe(false);
  });
});
