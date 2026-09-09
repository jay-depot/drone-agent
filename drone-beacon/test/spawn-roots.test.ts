import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expandSpawnRoots,
  initSpawnRoots,
  resolveSpawnRoots,
  getSpawnRoots,
  getDefaultSpawnRoot,
  isSpawnRootAllowed,
} from '../src/spawn-roots.js';

describe('expandSpawnRoots', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spawn-roots-test-'));
    await mkdir(path.join(dir, 'proj-a'));
    await mkdir(path.join(dir, 'proj-b'));
    await mkdir(path.join(dir, 'obsidian'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps literal paths and expands globs to immediate child dirs', async () => {
    const roots = await expandSpawnRoots([dir, path.join(dir, '*')]);
    expect(roots).toContain(path.resolve(dir));
    expect(roots).toContain(path.join(dir, 'proj-a'));
    expect(roots).toContain(path.join(dir, 'proj-b'));
    expect(roots).toContain(path.join(dir, 'obsidian'));
  });

  it('dedupes and sorts', async () => {
    const roots = await expandSpawnRoots([
      path.join(dir, 'proj-b'),
      path.join(dir, 'proj-a'),
      path.join(dir, 'proj-a'),
    ]);
    expect(roots).toEqual([path.join(dir, 'proj-a'), path.join(dir, 'proj-b')]);
  });

  it('skips globs whose base dir is missing', async () => {
    const roots = await expandSpawnRoots([path.join(dir, 'nonexistent', '*')]);
    expect(roots).toEqual([]);
  });
});

describe('resolveSpawnRoots', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spawn-roots-resolve-'));
    await mkdir(path.join(dir, 'proj-a'));
    await mkdir(path.join(dir, 'proj-b'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses the default when it is in the expanded set', async () => {
    const { roots, defaultRoot } = await resolveSpawnRoots({
      paths: [dir, path.join(dir, '*')],
      default: dir,
    });
    expect(roots).toContain(path.resolve(dir));
    expect(defaultRoot).toBe(path.resolve(dir));
  });

  it('falls back to the first expanded root when default is not in the set', async () => {
    const { roots, defaultRoot } = await resolveSpawnRoots({
      paths: [path.join(dir, 'proj-a'), path.join(dir, 'proj-b')],
      default: path.join(dir, 'not-a-root'),
    });
    expect(defaultRoot).toBe(path.join(dir, 'proj-a'));
    expect(roots).toContain(path.join(dir, 'proj-a'));
  });
});

describe('initSpawnRoots + enforcement helpers', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spawn-roots-init-'));
    await mkdir(path.join(dir, 'proj-a'));
    await mkdir(path.join(dir, 'proj-b'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('initializes the in-memory set and default', async () => {
    await initSpawnRoots({
      paths: [path.join(dir, 'proj-a'), path.join(dir, 'proj-b')],
      default: path.join(dir, 'proj-a'),
    });
    expect(getSpawnRoots()).toEqual([
      path.join(dir, 'proj-a'),
      path.join(dir, 'proj-b'),
    ]);
    expect(getDefaultSpawnRoot()).toBe(path.join(dir, 'proj-a'));
  });

  it('isSpawnRootAllowed accepts in-whitelist and rejects out-of-whitelist', async () => {
    await initSpawnRoots({
      paths: [path.join(dir, 'proj-a')],
      default: path.join(dir, 'proj-a'),
    });
    expect(isSpawnRootAllowed(path.join(dir, 'proj-a'))).toBe(true);
    expect(isSpawnRootAllowed(path.join(dir, 'proj-b'))).toBe(false);
  });
});
