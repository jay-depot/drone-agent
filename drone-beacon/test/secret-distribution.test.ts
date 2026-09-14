import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import { buildTestApp } from './app-helper.js';
import type { FastifyInstance } from 'fastify';
import {
  setCoordinatorClient,
  triggerCoordinatorSync,
} from '../src/routes/context.js';
import { setSecretOverlay, overlayEntries } from '../src/secret-overlay.js';
import { setPendingCoordinatorFingerprint, resetCoordinatorTrust } from '../src/coordinator-trust.js';
import type { CoordinatorClient } from '../src/coordinator-client.js';
import type { ResolvedConfigEntry } from 'drone-core';
import * as db from '../src/db/index.js';
import { getDatabase } from '../src/db/index.js';
import { resetCoordinatorWsClient } from '../src/coordinator-ws.js';

vi.mock('../src/ws-server.js', () => ({
  isLocalConnection: vi.fn().mockReturnValue(true),
  isAgentConnected: vi.fn().mockReturnValue(false),
  getConnectedAgents: vi.fn().mockReturnValue([]),
  getConnection: vi.fn().mockReturnValue(undefined),
  sendToAgent: vi.fn(),
  sendToChannel: vi.fn(),
  registerWebSocketServer: vi.fn(),
  startMessageCleanup: vi.fn(),
  pushFragmentSyncToAllConnected: vi.fn(),
}));

let app: FastifyInstance;

function makeFakeClient(
  overrides: Partial<CoordinatorClient> = {}
): CoordinatorClient {
  return {
    getBaseUrl: () => 'http://coordinator:3456',
    getFetch: () => fetch as typeof fetch,
    // No-op defaults so triggerCoordinatorSync reaches the config block.
    fetchPersonas: () => Promise.resolve([]),
    fetchSkills: () => Promise.resolve([]),
    pullKnowledge: () => Promise.resolve([]),
    fetchCoordinatorFragments: () => Promise.resolve([]),
    ...overrides,
  } as unknown as CoordinatorClient;
}

function resolvedEntry(
  key: string,
  value: string,
  containsSecrets: boolean
): ResolvedConfigEntry {
  return {
    key,
    value,
    secret: containsSecrets,
    description: null,
    updatedAt: 1000,
    containsSecrets,
  };
}

async function fakeSyncEntries(
  entries: ResolvedConfigEntry[],
  throws = false
): Promise<void> {
  const getCoordinatorDistribution = throws
    ? vi.fn().mockRejectedValue(new Error('coordinator down'))
    : vi.fn().mockResolvedValue(entries);
  setCoordinatorClient(
    makeFakeClient({ getCoordinatorDistribution } as unknown as CoordinatorClient)
  );
  await triggerCoordinatorSync();
}

beforeEach(async () => {
  await setupDb();
  app = await buildTestApp();
  setSecretOverlay([]);
  resetCoordinatorTrust();
  setPendingCoordinatorFingerprint(
    'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899'
  );
});

afterEach(async () => {
  setSecretOverlay([]);
  setCoordinatorClient(undefined);
  resetCoordinatorTrust();
  resetCoordinatorWsClient();
  await app.close();
  await teardownDb();
});

describe('secret-overlay', () => {
  it('setSecretOverlay clears and replaces; process memory only', () => {
    setSecretOverlay([
      resolvedEntry('providers.openai', 'sk-secret-1234', true),
    ]);
    expect(overlayEntries().map(e => e.key)).toEqual(['providers.openai']);
    setSecretOverlay([
      resolvedEntry('a', 'x', true),
      resolvedEntry('b', 'y', true),
    ]);
    expect(overlayEntries().map(e => e.key).sort()).toEqual(['a', 'b']);
    setSecretOverlay([]);
    expect(overlayEntries()).toEqual([]);
  });
});

describe('Coordinator config sync split', () => {
  it('persists only non-secret rows; secrets stay memory-only (never in SQLite)', async () => {
    await fakeSyncEntries([
      resolvedEntry('providers.openai', 'sk-real-1234', true),
      resolvedEntry('llm.active', '"openai/main"', false),
    ]);

    // Secret-bearing row is NOT in beacon_config.
    const rows = getDatabase()
      .prepare('SELECT key, value FROM beacon_config')
      .all() as Array<{ key: string; value: string }>;
    expect(rows.find(r => r.key === 'providers.openai')).toBeUndefined();
    expect(JSON.stringify(rows)).not.toContain('sk-real-1234');

    // Non-secret row IS persisted.
    expect(rows.find(r => r.key === 'llm.active')?.value).toBe('"openai/main"');

    // Overlay holds the secret value.
    expect(overlayEntries().map(e => e.key)).toEqual(['providers.openai']);
    expect(overlayEntries()[0]?.value).toBe('sk-real-1234');
  });

  it('merged GET /config exposes overlaid secret values without persisting them', async () => {
    await fakeSyncEntries([
      resolvedEntry('providers.openai', 'sk-real-9999', true),
    ]);
    const res = await app.inject({ method: 'GET', url: '/config' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Array<{ key: string; value: string }>;
    const provider = body.find(e => e.key === 'providers.openai')!;
    expect(provider.value).toBe('sk-real-9999');

    const rows = getDatabase()
      .prepare('SELECT key FROM beacon_config')
      .all() as Array<{ key: string }>;
    expect(rows.find(r => r.key === 'providers.openai')).toBeUndefined();
  });
});

describe('Coordinator config sync failure at boot', () => {
  it('keeps previous stores when sync throws; prior overlay cleared on next success', async () => {
    // First success fills stores.
    await fakeSyncEntries([
      resolvedEntry('providers.secret', 'sk-first-1111', true),
      resolvedEntry('llm.active', '"x"', false),
    ]);
    expect(overlayEntries()).toHaveLength(1);

    // Next sync throws — both stores untouched.
    await fakeSyncEntries([], true);
    const rows = getDatabase()
      .prepare('SELECT key, value FROM beacon_config')
      .all() as Array<{ key: string; value: string }>;
    expect(rows.find(r => r.key === 'llm.active')?.value).toBe('"x"');
    expect(overlayEntries().map(e => e.key)).toEqual(['providers.secret']);
  });
});
