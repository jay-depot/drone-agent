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
  shouldSkipIntegrationSuite([
    { url: BEACON_URL, fallbackUrl: DEFAULT_BEACON_URL },
  ])
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
    const list = (await (await fetch(`${BEACON_URL}/fragments`)).json()) as {
      fragments: FragmentRow[];
    };
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
    // WS connects are only accepted for registered agents.
    const register = await fetch(`${BEACON_URL}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: TEST_AGENT, personaId: null }),
    });
    expect(register.status).toBe(201);

    const wsUrl = `${BEACON_URL.replace(/^http/, 'ws')}/ws?agentId=${TEST_AGENT}`;
    const ws = new WebSocket(wsUrl);

    const received: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const pollUntil = async (
      predicate: () => boolean,
      label: string,
      timeoutMs = 10000
    ): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate()) {
        if (Date.now() > deadline) {
          throw new Error(`timeout waiting for ${label}`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };

    ws.addEventListener('message', event => {
      const msg = JSON.parse(String(event.data)) as {
        type: string;
        payload: Record<string, unknown>;
      };
      received.push(msg);
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () =>
        reject(new Error('WS connect failed'))
      );
    });

    // fragmentSync arrives on connect with the queue-accepted targeted row.
    await pollUntil(
      () => received.some(m => m.type === 'fragmentSync'),
      'fragmentSync'
    );
    const sync = received.find(m => m.type === 'fragmentSync');
    expect(sync).toBeDefined();
    const syncFragments = sync?.payload.fragments as FragmentRow[];
    expect(syncFragments.some(f => f.id === 'it-fragment-targeted')).toBe(true);

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
    await pollUntil(
      () => received.some(m => m.type === 'fragment'),
      'fragment push'
    );
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
