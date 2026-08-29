/**
 * Swarm prompt fragments integration tests (provisioned Docker swarm only).
 *
 * Flow: POST a broadcast fragment and a targeted fragment to the beacon REST
 * API, then assert both appear in GET /fragments and that a WS-connected test
 * client (registered under a test agentId) receives the fragmentSync set on
 * connect and live pushes on upsert/delete. Runs only under
 * RUN_INTEGRATION_TESTS=true with explicitly provided BEACON_URL; skips
 * otherwise (see shouldSkipIntegrationSuite).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getRequiredIntegrationEnv,
  shouldSkipIntegrationSuite,
  waitForService,
} from './fixtures/index.js';

const DEFAULT_BEACON_URL = 'http://localhost:3457';
const BEACON_URL = getRequiredIntegrationEnv('BEACON_URL', DEFAULT_BEACON_URL);
const TEST_AGENT = `fragment-it-agent-${Date.now()}`;

interface FragmentRow {
  id: string;
  target: string;
  content: string;
  phase: string;
  scope: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

describe.skipIf(
  shouldSkipIntegrationSuite([{ url: BEACON_URL, fallbackUrl: DEFAULT_BEACON_URL }])
)('Swarm Prompt Fragments (integration)', () => {
  beforeAll(async () => {
    const ready = await waitForService(BEACON_URL);
    if (!ready) {
      throw new Error(`Beacon not available at ${BEACON_URL}`);
    }
  });

  afterAll(async () => {
    // Best-effort cleanup so repeat runs start clean.
    for (const id of ['it-fragment-broadcast', 'it-fragment-targeted']) {
      await fetch(`${BEACON_URL}/fragments/${id}?target=broadcast`, {
        method: 'DELETE',
      }).catch(() => {});
      await fetch(`${BEACON_URL}/fragments/${id}?target=${TEST_AGENT}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    await fetch(`${BEACON_URL}/agents/${TEST_AGENT}`, {
      method: 'DELETE',
    }).catch(() => {});
  });

  it('accepts a targeted fragment for an unknown agentId (accept-and-queue)', async () => {
    const res = await fetch(`${BEACON_URL}/fragments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'it-fragment-targeted',
        target: TEST_AGENT,
        content: 'queued before connect',
      }),
    });
    expect(res.status).toBe(200);
  });

  it('broadcast fragment set/delete round-trip through REST', async () => {
    const post = await fetch(`${BEACON_URL}/fragments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'it-fragment-broadcast',
        target: 'broadcast',
        content: 'integration broadcast',
      }),
    });
    expect(post.status).toBe(200);
    const list = (await (
      await fetch(`${BEACON_URL}/fragments`)
    ).json()) as { fragments: FragmentRow[] };
    expect(
      list.fragments.some(
        f => f.id === 'it-fragment-broadcast' && f.target === 'broadcast'
      )
    ).toBe(true);

    const del = await fetch(
      `${BEACON_URL}/fragments/it-fragment-broadcast?target=broadcast`,
      { method: 'DELETE' }
    );
    expect(del.status).toBe(200);
  });

  it('delivers fragmentSync on WS connect with the full merged set and live pushes thereafter', async () => {
    const wsUrl = `${BEACON_URL.replace(/^http/, 'ws')}/ws?agentId=${TEST_AGENT}`;
    const ws = new WebSocket(wsUrl);

    const received: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const waiter = { fragmentSync: false, push: false };
    let notify: (() => void) | undefined;
    const signal = () => {
      const cb = notify;
      notify = undefined;
      cb?.();
    };
    const waitFor = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        notify = resolve;
        setTimeout(() => reject(new Error('timeout waiting for WS frame')), ms);
      });

    ws.on('message', raw => {
      const msg = JSON.parse(String(raw)) as {
        type: string;
        payload: Record<string, unknown>;
      };
      received.push(msg);
      if (msg.type === 'fragmentSync' && !waiter.fragmentSync) {
        waiter.fragmentSync = true;
        signal();
      }
      if (msg.type === 'fragment' && !waiter.push) {
        waiter.push = true;
        signal();
      }
    });

    const connected = await new Promise<boolean>((resolve, reject) => {
      ws.once('open', () => resolve(true));
      ws.once('error', err => reject(err));
    });
    expect(connected).toBe(true);

    // fragmentSync arrives on connect with the queued targeted row.
    await waitFor(10000);
    const sync = received.find(m => m.type === 'fragmentSync');
    expect(sync).toBeDefined();
    const syncFragments = sync?.payload.fragments as FragmentRow[];
    expect(
      syncFragments.some(f => f.id === 'it-fragment-targeted')
    ).toBe(true);

    // Live push on targeted upsert.
    const post = await fetch(`${BEACON_URL}/fragments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'it-fragment-targeted-2',
        target: TEST_AGENT,
        content: 'live push',
      }),
    });
    expect(post.status).toBe(200);
    await waitFor(10000);
    const push = received.find(m => m.type === 'fragment');
    expect(push).toBeDefined();
    expect((push?.payload.fragment as FragmentRow).id).toBe(
      'it-fragment-targeted-2'
    );

    // Deletion pushes a remove op.
    const del = await fetch(
      `${BEACON_URL}/fragments/it-fragment-targeted-2?target=${TEST_AGENT}`,
      { method: 'DELETE' }
    );
    expect(del.status).toBe(200);

    ws.close();
  });
});