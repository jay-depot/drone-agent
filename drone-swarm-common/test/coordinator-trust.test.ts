import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadCoordinatorTrust,
  saveCoordinatorTrust,
} from '../src/coordinator-trust.js';

describe('coordinator trust file', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'drone-trust-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('round-trips the trust record', async () => {
    const trust = {
      coordinatorUrl: 'https://10.0.0.5:3456',
      tlsFingerprint: 'deadbeef',
    };
    await saveCoordinatorTrust(dataDir, trust);
    const loaded = await loadCoordinatorTrust(dataDir);
    expect(loaded).toEqual(trust);
  });

  it('returns undefined when the file is missing', async () => {
    expect(await loadCoordinatorTrust(dataDir)).toBeUndefined();
  });

  it('writes the trust file with mode 0600', async () => {
    await saveCoordinatorTrust(dataDir, {
      coordinatorUrl: 'https://10.0.0.5:3456',
      tlsFingerprint: 'deadbeef',
    });
    const stats = await stat(path.join(dataDir, 'coordinator-trust.json'));
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
