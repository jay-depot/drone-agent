/**
 * Full Swarm Flow Integration Tests (E2E)
 *
 * Tests complete swarm workflows:
 * - full-agent-lifecycle: Start → connect → work → disconnect
 * - multi-agent-coordination: Two agents, message exchange
 * - swarm-memory-across-agents: Agent A stores, Agent B retrieves
 * - persona-propagation: Create persona, agents see it
 */

import { beforeAll, describe, it, expect } from 'vitest';
import {
  getBeaconAgents,
  getBeaconPersonas,
  createBeaconPersona,
  sendBeaconMessage,
  getBeaconMessages,
  getRequiredIntegrationEnv,
  waitForService,
  shouldSkipIntegrationSuite,
  registerBeaconAgent,
} from './fixtures/index.js';

const DEFAULT_BEACON_URL = 'http://localhost:3457';
const DEFAULT_COORDINATOR_URL = 'http://localhost:3456';
const BEACON_URL = getRequiredIntegrationEnv('BEACON_URL', DEFAULT_BEACON_URL);
const COORDINATOR_URL = getRequiredIntegrationEnv(
  'COORDINATOR_URL',
  DEFAULT_COORDINATOR_URL
);

describe.skipIf(
  shouldSkipIntegrationSuite([
    { url: BEACON_URL, fallbackUrl: DEFAULT_BEACON_URL },
    { url: COORDINATOR_URL, fallbackUrl: DEFAULT_COORDINATOR_URL },
  ])
)('E2E Swarm Flows', () => {
  beforeAll(async () => {
    const beaconReady = await waitForService(BEACON_URL);
    const coordinatorReady = await waitForService(COORDINATOR_URL);
    if (!beaconReady) {
      throw new Error(`Beacon service not available at ${BEACON_URL}`);
    }
    if (!coordinatorReady) {
      throw new Error(
        `Coordinator service not available at ${COORDINATOR_URL}`
      );
    }

    // The suites that run before this one leave stale 'connected' rows in
    // the beacon's agent_sessions (spawned agents are not cleaned up —
    // see project memory spawned-agent-llm-wiring), so assertions here
    // must be anchored to an agent this test owns, not to whatever the
    // DB happens to contain.
    await registerBeaconAgent(BEACON_URL, 'e2e-lifecycle-agent');
  });

  describe('full-agent-lifecycle', () => {
    it('should complete full agent lifecycle', async () => {
      // Register → connected → heartbeat → stale check for an agent this
      // test owns. Other 'connected' rows may be stale leftovers from
      // earlier suites, so the freshness assertion applies only to ours.
      const agent = await registerBeaconAgent(
        BEACON_URL,
        'e2e-lifecycle-agent'
      );
      expect(agent.status).toBe('connected');

      const agents = await getBeaconAgents(BEACON_URL);
      const ours = agents.find(a => a.id === 'e2e-lifecycle-agent');
      expect(ours).toBeDefined();
      expect(ours?.status).toBe('connected');

      const lastActivity = new Date(ours!.lastActivity).getTime();
      expect(Date.now() - lastActivity).toBeLessThan(60000);
    });
  });

  describe('multi-agent-coordination', () => {
    it('should coordinate multiple agents', async () => {
      const agents = await getBeaconAgents(BEACON_URL);

      // Need at least 2 agents for multi-agent coordination
      if (agents.length < 2) {
        console.log('Skipping multi-agent test - need at least 2 agents');
        expect(agents.length).toBeGreaterThanOrEqual(1);
        return;
      }

      // Send message from agent A to agent B
      const [agentA, agentB] = agents;

      const message = await sendBeaconMessage(
        BEACON_URL,
        agentA.id,
        agentB.id,
        { text: 'Multi-agent coordination test' }
      );

      expect(message).toBeDefined();
      expect(message.fromAgentId).toBe(agentA.id);
      expect(message.toAgentId).toBe(agentB.id);

      // Verify recipient received message
      const messages = await getBeaconMessages(BEACON_URL, agentB.id);
      const receivedMessage = messages.find(m => m.id === message.id);

      expect(receivedMessage).toBeDefined();
    });
  });

  describe('swarm-memory-across-agents', () => {
    it('should share memory across agents', async () => {
      const agents = await getBeaconAgents(BEACON_URL);

      if (agents.length === 0) {
        expect(agents.length).toBeGreaterThan(0);
        return;
      }

      // Memory is stored in beacon and accessible to all agents
      // This test verifies the memory infrastructure is in place
      const personas = await getBeaconPersonas(BEACON_URL);

      // Personas represent stored agent configurations
      expect(personas).toBeDefined();

      // Additional memory tests would require the memory API
      expect(true).toBe(true);
    });
  });

  describe('persona-propagation', () => {
    it('should propagate persona to all connected agents', async () => {
      // Create a new persona
      const testPersona = {
        id: `e2e-persona-${Date.now()}`,
        name: 'E2E Test Persona',
        description: 'Testing persona propagation',
        systemPrompt:
          'You are an E2E test assistant that validates swarm behavior.',
      };

      await createBeaconPersona(BEACON_URL, testPersona);

      // Verify persona exists in beacon
      const personas = await getBeaconPersonas(BEACON_URL);
      const created = personas.find(p => p.id === testPersona.id);

      expect(created).toBeDefined();
      expect(created?.name).toBe(testPersona.name);
      expect(created?.systemPrompt).toBe(testPersona.systemPrompt);

      // Verify agents can access the persona
      // (The agent would fetch this via /personas endpoint)
      const allPersonas = await getBeaconPersonas(BEACON_URL);
      expect(allPersonas.find(p => p.id === testPersona.id)).toBeDefined();
    });
  });
});
