/**
 * mcp-swarm end-to-end smoke test (provisioned swarm only).
 *
 * Starts the reference extension against a real coordinator, asserts the
 * capability catalog round-trips through the coordinator's `/api/extensions`
 * listing, and that an action invocation reaches the extension and returns.
 *
 * Skipped unless RUN_INTEGRATION_TESTS=true and an explicit
 * MCP_SWARM_COORDINATOR_URL is provided (never touches a user's local
 * coordinator).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMcpSwarm } from '../src/index.js';

const COORDINATOR_URL = process.env.MCP_SWARM_COORDINATOR_URL ?? '';
const shouldSkip =
  process.env.RUN_INTEGRATION_TESTS !== 'true' || COORDINATOR_URL === '';

describe.skipIf(shouldSkip)('mcp-swarm end-to-end', () => {
  let dataDir = '';
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'mcp-swarm-it-'));
    const started = await startMcpSwarm({
      coordinatorUrl: COORDINATOR_URL,
      dataDir,
      id: 'mcp-swarm',
    });
    stop = started.stop;
  }, 30000);

  afterAll(async () => {
    await stop?.();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('appears in the coordinator extension listing with its catalog', async () => {
    // The coordinator auto-approves local nodes; give the WS a moment to
    // declare the manifest.
    let rows: Array<{
      nodeId: string;
      capabilities: Array<{ name: string }>;
    }> = [];
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${COORDINATOR_URL}/api/extensions`);
      if (res.ok) {
        rows = (await res.json()) as typeof rows;
        if (rows.some(r => r.nodeId === 'mcp-swarm')) break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    const self = rows.find(r => r.nodeId === 'mcp-swarm');
    expect(self).toBeDefined();
    expect(self!.capabilities.map(c => c.name).sort()).toEqual([
      'swarm.agent.list',
      'swarm.session.list',
      'swarm.wiki.read',
    ]);
  });

  it('round-trips an action invocation', async () => {
    const res = await fetch(
      `${COORDINATOR_URL}/api/extensions/mcp-swarm/actions/swarm.session.list`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { status: 'active' } }),
      }
    );
    expect([200, 201]).toContain(res.status);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
