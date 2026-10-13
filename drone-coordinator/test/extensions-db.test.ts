import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  initDatabase,
  closeDatabase,
  upsertCapabilityCache,
  getCapabilityCache,
  listCapabilityCache,
  deleteCapabilityCache,
  upsertBundle,
  getBundle,
  deleteBundle,
  listBundles,
  listBundleDescriptors,
  createSwarmSession,
  getSwarmSession,
  listActiveSessionSnapshots,
} from '../src/db/index.js';
import type { DroneExtensionManifest, DroneSessionSnapshot } from 'drone-core';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function manifest(name = 'alpha'): DroneExtensionManifest {
  return {
    protocolVersion: 1,
    capabilities: [
      {
        name,
        description: 'Test capability',
        paramSchema: { type: 'object' },
      },
    ],
    bundles: [],
  };
}

describe('Extension capability cache', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('round-trips a manifest', () => {
    upsertCapabilityCache('node-1', manifest());
    const row = getCapabilityCache('node-1');
    expect(row?.nodeId).toBe('node-1');
    expect(row?.manifest.capabilities[0].name).toBe('alpha');
  });

  it('replaces an existing manifest', () => {
    upsertCapabilityCache('node-1', manifest('alpha'));
    upsertCapabilityCache('node-1', manifest('beta'));
    expect(getCapabilityCache('node-1')?.manifest.capabilities[0].name).toBe(
      'beta'
    );
  });

  it('returns undefined for an unknown node', () => {
    expect(getCapabilityCache('missing')).toBeUndefined();
  });

  it('lists and deletes entries', () => {
    upsertCapabilityCache('node-1', manifest());
    upsertCapabilityCache('node-2', manifest());
    expect(listCapabilityCache().map(r => r.nodeId)).toEqual([
      'node-1',
      'node-2',
    ]);
    expect(deleteCapabilityCache('node-1')).toBe(true);
    expect(listCapabilityCache().map(r => r.nodeId)).toEqual(['node-2']);
  });
});

describe('Extension bundles', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  function bundleRow(nodeId: string, name: string, hash: string) {
    return {
      nodeId,
      name,
      version: '1.0.0',
      hash,
      path: `/tmp/${nodeId}/${name}/${hash}`,
      updatedAt: Date.now(),
    };
  }

  it('upserts and reads a bundle', () => {
    upsertBundle(bundleRow('node-1', 'panel', 'h1'));
    const row = getBundle('node-1', 'panel');
    expect(row?.version).toBe('1.0.0');
    expect(row?.hash).toBe('h1');
  });

  it('replaces a bundle on re-upload', () => {
    upsertBundle(bundleRow('node-1', 'panel', 'h1'));
    upsertBundle({ ...bundleRow('node-1', 'panel', 'h2'), version: '2.0.0' });
    const row = getBundle('node-1', 'panel');
    expect(row?.hash).toBe('h2');
    expect(row?.version).toBe('2.0.0');
  });

  it('lists bundles globally and filtered by node', () => {
    upsertBundle(bundleRow('node-1', 'panel', 'h1'));
    upsertBundle(bundleRow('node-2', 'panel', 'h2'));
    expect(listBundles()).toHaveLength(2);
    expect(listBundles('node-1').map(b => b.nodeId)).toEqual(['node-1']);
  });

  it('deletes a bundle', () => {
    upsertBundle(bundleRow('node-1', 'panel', 'h1'));
    expect(deleteBundle('node-1', 'panel')).toBe(true);
    expect(getBundle('node-1', 'panel')).toBeUndefined();
  });

  it('lists bundle descriptors for the UI', () => {
    upsertBundle(bundleRow('node-1', 'panel', 'h1'));
    const descriptors = listBundleDescriptors('node-1');
    expect(descriptors).toEqual([
      { name: 'panel', version: '1.0.0', hash: 'h1' },
    ]);
  });
});

describe('Swarm session snapshot', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  const snapshot: DroneSessionSnapshot = {
    protocolVersion: 1,
    sessionId: 'ss1',
    personaId: 'coder',
    beaconId: 'ss1',
    interactive: false,
    isSubagent: false,
    cwd: '/tmp',
    enabledPlugins: ['swarm', 'extensions'],
    mountedTools: ['file__read'],
    extensionHint: 'gateway',
  };

  it('round-trips a snapshot', () => {
    createSwarmSession('ss1', 'coder', 'b1', false, snapshot);
    const session = getSwarmSession('ss1');
    expect(session?.sessionSnapshot).toEqual(snapshot);
  });

  it('defaults the snapshot to null', () => {
    createSwarmSession('ss2', null, 'b1');
    expect(getSwarmSession('ss2')?.sessionSnapshot).toBeNull();
  });

  it('lists snapshots of active sessions only', () => {
    createSwarmSession('ss1', null, 'b1', false, snapshot);
    createSwarmSession('ss3', null, 'b1');
    const snaps = listActiveSessionSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].sessionId).toBe('ss1');
  });
});

describe('Extension migration idempotency', () => {
  it('runs twice without error and preserves rows', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'drone-ext-mig-'));
    const dbFile = path.join(dir, 'test.db');
    initDatabase(dbFile);
    upsertCapabilityCache('node-1', manifest());
    upsertBundle({
      nodeId: 'node-1',
      name: 'panel',
      version: '1.0.0',
      hash: 'h1',
      path: '/tmp/x',
      updatedAt: Date.now(),
    });
    closeDatabase();
    initDatabase(dbFile);
    expect(getCapabilityCache('node-1')?.manifest.capabilities[0].name).toBe(
      'alpha'
    );
    expect(getBundle('node-1', 'panel')?.hash).toBe('h1');
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });
});
