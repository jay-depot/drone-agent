/**
 * Reverse-channel (coordinator -> beacon WebSocket) integration tests.
 *
 * Verifies the two coordinator-originated command paths travel over the
 * beacon's outbound reverse-channel WebSocket instead of inbound HTTP:
 *
 * - direct API spawn: the coordinator's POST /api/spawn has NO HTTP
 *   fallback, so a success proves the reverse channel delivered the command
 *   end to end.
 * - session-end hook: ending a swarm session fires the configured
 *   sessionEnd spawn trigger, which prefers the reverse channel and falls
 *   back to HTTP. Because the direct-spawn test gates on the channel being
 *   up, a spawn record appearing after session end cannot be fallback luck.
 *
 * All coordinator-facing calls go through the beacon's coordinator proxy:
 * the coordinator requires mTLS client certs, which the test-runner cannot
 * present (only the beacon holds coordinator credentials — the exact trust
 * boundary the reverse channel exists to preserve).
 *
 * Spawned agents in this swarm have no working LLM wiring (see project
 * memory: spawned-agent-llm-wiring), so all assertions are on spawn records
 * and lifecycle, never on LLM-driven agent behavior.
 */

import { beforeAll, describe, it, expect, afterAll } from 'vitest';
import {
  getRequiredIntegrationEnv,
  waitForService,
  shouldSkipIntegrationSuite,
  post,
  del,
  get,
} from './fixtures/index.js';

const DEFAULT_BEACON_URL = 'http://localhost:3457';
const BEACON_URL = getRequiredIntegrationEnv('BEACON_URL', DEFAULT_BEACON_URL);

const BEACON_ID = 'beacon-teste2e';
const PERSONA_ID = 'e2e-reverse-agent';

const spawnedAgentIds: string[] = [];

describe.skipIf(
  shouldSkipIntegrationSuite([
    { url: BEACON_URL, fallbackUrl: DEFAULT_BEACON_URL },
  ])
)('Reverse-Channel Swarm Flows', () => {
  beforeAll(async () => {
    if (!(await waitForService(BEACON_URL))) {
      throw new Error(`Beacon service not available at ${BEACON_URL}`);
    }

    // The persona must exist AT THE BEACON — spawn validation is beacon-side.
    // GET-first so re-runs against the persistent beacon volume stay green.
    const existing = (await get<Array<{ id: string }>>(
      `${BEACON_URL}/personas`
    ).catch(() => [])) as Array<{ id: string }>;
    if (!existing.some(p => p.id === PERSONA_ID)) {
      await post(`${BEACON_URL}/personas`, {
        id: PERSONA_ID,
        name: 'E2E Reverse Channel Agent',
        description: 'Persona used by reverse-channel integration tests',
        systemPrompt: 'You are a test agent. Respond briefly.',
        color: '#44aa88',
        capabilities: {},
      });
    }

    // The beacon must be registered at the coordinator, or the coordinator
    // cannot resolve the reverse channel's client cert to a beacon ID.
    // The proxy answers 503 "Coordinator not configured" until the beacon
    // finishes registering with the coordinator, so poll through that
    // startup window before judging registration.
    const deadline = Date.now() + 60000;
    let registered = false;
    while (Date.now() < deadline) {
      const beacons = (await get<Array<{ id: string }>>(
        `${BEACON_URL}/coordinator/beacons`
      ).catch(() => [])) as Array<{ id: string }>;
      if (beacons.some(b => b.id === BEACON_ID)) {
        registered = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!registered) {
      throw new Error(
        `Beacon ${BEACON_ID} never registered at the coordinator; reverse-channel tests cannot run`
      );
    }
  }, 120000);

  afterAll(async () => {
    // Best-effort cleanup of anything we spawned but did not terminate
    // inline; a stray agent must not poison subsequent runs.
    for (const spawnId of spawnedAgentIds) {
      try {
        await del(`${BEACON_URL}/coordinator/spawn/${BEACON_ID}/${spawnId}`);
      } catch {
        // already gone
      }
    }
  });

  it('delivers an API spawn command over the reverse channel', async () => {
    const created = (await post<{ spawnId: string; agentId: string }>(
      `${BEACON_URL}/coordinator/spawn`,
      {
        targetBeaconId: BEACON_ID,
        personaId: PERSONA_ID,
        task: 'reverse-channel api-spawn probe',
      }
    )) as { spawnId: string; agentId: string };
    expect(created.spawnId).toBeTruthy();
    expect(created.agentId).toBeTruthy();
    spawnedAgentIds.push(created.spawnId);

    const terminated = (await del(
      `${BEACON_URL}/coordinator/spawn/${BEACON_ID}/${created.spawnId}`
    )) as unknown;
    expect(terminated).toBeTruthy();
  });

  it('spawns the configured persona when a swarm session ends', async () => {
    const sessionId = `e2e-reverse-${Date.now()}`;
    await post(`${BEACON_URL}/sync/sessions/register`, {
      id: sessionId,
      personaId: PERSONA_ID,
      beaconId: BEACON_ID,
    });

    // Ends the session at the coordinator; the coordinator's session-end
    // hook then fires the configured spawn trigger toward beacon-teste2e.
    await del(`${BEACON_URL}/sync/sessions/${sessionId}`);

    // Poll the beacon's own spawn list for the trigger's spawn: the task
    // string embeds the session id (coordinator/src/session-end.ts). The
    // session register/end may sit in the beacon's durable outbox for up to
    // one flush interval (60s) before the coordinator sees them and fires
    // the hook, so the deadline must exceed that.
    const deadline = Date.now() + 90000;
    let spawnRecord:
      { id: string; personaId: string | null; task: string | null } | undefined;
    while (Date.now() < deadline) {
      const list = (await get(`${BEACON_URL}/spawn`)) as Array<{
        id: string;
        personaId: string | null;
        task: string | null;
      }>;
      spawnRecord = Array.isArray(list)
        ? list.find(s => (s.task ?? '').includes(sessionId))
        : undefined;
      if (spawnRecord) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(spawnRecord).toBeDefined();
    expect(spawnRecord?.personaId).toBe(PERSONA_ID);
    if (spawnRecord) {
      spawnedAgentIds.push(spawnRecord.id);
    }

    const terminated = (await del(
      `${BEACON_URL}/coordinator/spawn/${BEACON_ID}/${spawnRecord?.id ?? ''}`
    )) as unknown;
    expect(terminated).toBeTruthy();
  }, 120000);
});
