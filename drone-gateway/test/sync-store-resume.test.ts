import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from 'matrix-js-sdk';
import type { MatrixClient } from 'matrix-js-sdk';
import { openGatewayDb, type GatewayDatabase } from '../src/store/db.js';
import { SqliteSyncStore } from '../src/store/sqlite-sync-store.js';
import { roomSync, incrementalSync } from './fixtures/sync.js';

/**
 * Regression tests for DRONE-GW-BUG-002.
 *
 * A /sync response is a delta. The store must accumulate responses so that a
 * restarted client still knows its joined rooms; storing only the last
 * response leaves a token with no room data, the client resumes an
 * incremental sync, and every reply fails with "unknown conversation".
 *
 * These tests drive a REAL MatrixClient (no module mock) through a
 * start -> sync -> restart -> sync cycle over a real SQLite store, which is
 * the only way to observe the store/SDK contract that the isolated and
 * fully-mocked suites cannot.
 */
describe('SqliteSyncStore: restart preserves rooms (DRONE-GW-BUG-002)', () => {
  let dir: string;
  let dbPath: string;
  let client: MatrixClient | undefined;
  let db: GatewayDatabase | undefined;

  function newStore(): SqliteSyncStore {
    db = openGatewayDb(dbPath);
    return new SqliteSyncStore(db);
  }

  function newClient(store?: SqliteSyncStore): MatrixClient {
    return createClient({
      baseUrl: 'https://example.invalid',
      accessToken: 'test-token',
      userId: '@bot:example.invalid',
      deviceId: 'DRONEGW',
      ...(store ? { store } : {}),
    });
  }

  async function waitForRooms(
    c: MatrixClient,
    minimum: number,
    timeoutMs: number
  ): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const count = c.getRooms().length;
      if (count >= minimum) return count;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return c.getRooms().length;
  }

  afterEach(() => {
    client?.stopClient();
    client = undefined;
    db?.close();
    db = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('getSavedSync still lists the joined room after an incremental sync', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gw-sync-'));
    dbPath = path.join(dir, 'gateway.sqlite');

    const store = newStore();
    await store.setSyncData(roomSync('s1'));
    await store.setSyncData(incrementalSync('s2'));

    const saved = await store.getSavedSync();
    expect(saved).not.toBeNull();
    expect(saved!.nextBatch).toBe('s2');
    expect(Object.keys(saved!.roomsData.join)).toContain('!room:test');
  });

  it('a restarted client resuming from the store still knows its rooms', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gw-sync-'));
    dbPath = path.join(dir, 'gateway.sqlite');

    const store = newStore();
    await store.setSyncData(roomSync('s1'));
    await store.setSyncData(incrementalSync('s2'));
    db!.close();
    db = undefined;

    client = newClient(newStore());
    client.startClient({ initialSyncLimit: 10 }).catch(() => {
      // The example.invalid homeserver is unreachable; the cached sync is
      // processed locally, which is what this test exercises.
    });

    const roomCount = await waitForRooms(client, 1, 5000);
    expect(roomCount).toBeGreaterThan(0);
  }, 20000);
});
