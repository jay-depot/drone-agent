import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTokenStore, type TokenStore } from '../src/token-store.js';

let dataDir = '';
let activeStore: TokenStore | undefined;
const silent = () => {};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-swarm-tokens-'));
  activeStore = undefined;
});

afterEach(async () => {
  await activeStore?.flush();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

async function openStore(): Promise<TokenStore> {
  activeStore = await loadTokenStore(dataDir, { log: silent });
  return activeStore;
}

async function readStore() {
  const raw = await readFile(path.join(dataDir, 'tokens.json'), 'utf8');
  return JSON.parse(raw) as {
    version: number;
    tokens: Array<{ id: string; name: string; hash: string }>;
  };
}

describe('loadTokenStore', () => {
  it('bootstraps a single default token and a 0600 plaintext file', async () => {
    const store = await openStore();
    const list = store.list();
    expect(list.map(t => t.name)).toEqual(['default']);

    const stored = await readStore();
    expect(stored.version).toBe(1);
    expect(stored.tokens).toHaveLength(1);

    const plaintext = await readFile(path.join(dataDir, 'token'), 'utf8');
    expect(plaintext).toMatch(/^mcpsw_[0-9a-f]{64}$/);
    const mode = (await stat(path.join(dataDir, 'token'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does not store the plaintext in tokens.json', async () => {
    const store = await openStore();
    const plaintext = await readFile(path.join(dataDir, 'token'), 'utf8');
    const raw = await readFile(path.join(dataDir, 'tokens.json'), 'utf8');
    expect(raw).not.toContain(plaintext);
    expect(store.list()[0]).not.toHaveProperty('hash');
  });

  it('reloads an existing store without re-bootstrapping', async () => {
    const first = await openStore();
    first.create('work-laptop');
    await first.flush();

    const second = await openStore();
    expect(second.list().map(t => t.name).sort()).toEqual([
      'default',
      'work-laptop',
    ]);
  });

  it('creates, lists, and renames a token', async () => {
    const store = await openStore();
    const { entry, token } = store.create('ci');
    expect(token).toMatch(/^mcpsw_[0-9a-f]{64}$/);
    expect(entry.name).toBe('ci');

    const renamed = store.rename(entry.id, 'ci-renamed');
    expect(renamed?.name).toBe('ci-renamed');
    expect(store.list().find(t => t.id === entry.id)?.name).toBe('ci-renamed');

    expect(store.rename('missing', 'x')).toBeUndefined();
  });

  it('revokes a token', async () => {
    const store = await openStore();
    const { entry } = store.create('to-revoke');
    expect(store.revoke(entry.id)).toBe(true);
    expect(store.list().some(t => t.id === entry.id)).toBe(false);
    expect(store.revoke(entry.id)).toBe(false);
  });

  it('verifies a valid token and rejects a bad one', async () => {
    const store = await openStore();
    const { token } = store.create('client');
    expect(store.verify(token)?.name).toBe('client');
    expect(store.verify('mcpsw_deadbeef')).toBeUndefined();
  });

  it('updates lastUsedAt after a successful verify', async () => {
    const store = await openStore();
    const { entry, token } = store.create('client');
    expect(entry.lastUsedAt).toBeUndefined();

    expect(store.verify(token)).toBeDefined();
    expect(store.list().find(t => t.id === entry.id)?.lastUsedAt).toBeGreaterThan(
      0
    );
  });

  it('does not corrupt the file under parallel writes', async () => {
    const store = await openStore();
    await Promise.all([
      store.flush(),
      store.flush(),
      store.flush(),
      store.flush(),
    ]);
    const stored = await readStore();
    expect(stored.tokens).toHaveLength(1);
  });

  it('persists created tokens to disk', async () => {
    const store = await openStore();
    store.create('persisted');
    await store.flush();
    const stored = await readStore();
    expect(stored.tokens.map(t => t.name).sort()).toEqual([
      'default',
      'persisted',
    ]);
    for (const entry of stored.tokens) {
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
