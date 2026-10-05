import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MatrixServiceAdapter } from '../src/adapters/matrix.js';
import { openGatewayDb, type GatewayDatabase } from '../src/store/db.js';
import { SqliteSyncStore } from '../src/store/sqlite-sync-store.js';
import type { AdapterMessage } from '../src/types.js';
import { syncWithMessage } from './fixtures/sync.js';

/**
 * Regression test for the swarm-console replay bug.
 *
 * A persistent sync store makes the SDK replay the cached /sync on restart.
 * Those cached timeline events are re-emitted as RoomEvent.Timeline with
 * `toStartOfTimeline === false` and `data.liveEvent === false`, so a handler
 * that filters only on `toStartOfTimeline` re-dispatches historical commands
 * as if they were new input — an old command's reply then "answers" an
 * unrelated later message, and each restart re-fires the cached commands.
 *
 * This drives a REAL MatrixClient (no mock) over a seeded SQLite store and
 * asserts the cached command is NOT re-dispatched on restart.
 */
describe('MatrixServiceAdapter: does not re-dispatch replayed cached sync', () => {
  let dir: string;
  let db: GatewayDatabase | undefined;
  let adapter: MatrixServiceAdapter | undefined;

  afterEach(async () => {
    await adapter?.stop();
    adapter = undefined;
    db?.close();
    db = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('does not emit a message for a command replayed from the cached sync', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gw-replay-'));
    const dbPath = path.join(dir, 'gateway.sqlite');

    db = openGatewayDb(dbPath);
    await new SqliteSyncStore(db).setSyncData(
      syncWithMessage('s1', {
        sender: '@alice:test',
        body: 'swarm.beacon.list',
      })
    );
    db.close();
    db = undefined;

    adapter = new MatrixServiceAdapter('matrix-replay', {
      homeserverUrl: 'https://example.invalid',
      accessToken: 'test-token',
      userId: '@bot:test',
      deviceId: 'DRONEGW',
      dataPath: dbPath,
    });

    const messages: AdapterMessage[] = [];
    adapter.onMessage(msg => messages.push(msg));

    await adapter.start();
    await new Promise(resolve => setTimeout(resolve, 1500));

    expect(messages).toHaveLength(0);
  }, 20000);
});
