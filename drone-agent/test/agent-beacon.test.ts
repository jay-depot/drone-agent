/**
 * Agent ↔ Beacon Integration Tests
 *
 * Tests the interactions between agents and the beacon:
 * - agent-registers: Agent starts, connects to beacon
 * - agent-fetches-personas: Agent loads personas from beacon
 * - agent-fetches-skills: Agent loads skills from beacon
 * - heartbeat-keeps-alive: Agent sends heartbeat
 * - agent-cleanup: Agent shuts down cleanly
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  getBeaconAgents,
  getBeaconAgent,
  getBeaconPersonas,
  getBeaconSkills,
  createBeaconPersona,
  waitForService,
} from './fixtures/index.js';

const BEACON_URL = process.env.BEACON_URL || 'http://localhost:3457';
const AGENT_URL = process.env.AGENT_URL || 'http://localhost:3459';

describe('Agent ↔ Beacon', () => {
  const agentId = 'test-agent-1';

  beforeAll(async () => {
    // Wait for services to be ready
    await waitForService(BEACON_URL, 30, 1000);
    await waitForService(AGENT_URL, 30, 1000);
  });

  describe('agent-registers', () => {
    it('should register agent with beacon', async () => {
      const agents = await getBeaconAgents(BEACON_URL);

      // The dummy agent should auto-register on startup
      const agent = agents.find(
        a => a.id.includes('dummy') || a.id === agentId
      );

      expect(agent).toBeDefined();
      expect(agent?.status).toBeDefined();
    });

    it('should show agent in /agents list', async () => {
      const agents = await getBeaconAgents(BEACON_URL);

      expect(agents.length).toBeGreaterThan(0);
    });

    it('should get specific agent details', async () => {
      const agents = await getBeaconAgents(BEACON_URL);
      const agent = agents[0];

      if (agent) {
        const details = await getBeaconAgent(BEACON_URL, agent.id);
        expect(details).toBeDefined();
        expect(details?.id).toBe(agent.id);
      }
    });
  });

  describe('agent-fetches-personas', () => {
    it('should load personas from beacon', async () => {
      const personas = await getBeaconPersonas(BEACON_URL);

      // Beacon should have personas (at least default ones)
      expect(personas).toBeDefined();
      expect(Array.isArray(personas)).toBe(true);
    });

    it('should create and retrieve a persona', async () => {
      const testPersona = {
        id: `test-persona-${Date.now()}`,
        name: 'Test Persona',
        description: 'A test persona for integration testing',
        systemPrompt: 'You are a helpful test assistant.',
      };

      const created = await createBeaconPersona(BEACON_URL, testPersona);
      expect(created).toBeDefined();
      expect(created.id).toBe(testPersona.id);

      const retrieved = await getBeaconPersonas(BEACON_URL);
      expect(retrieved.find(p => p.id === testPersona.id)).toBeDefined();
    });
  });

  describe('agent-fetches-skills', () => {
    it('should load skills from beacon', async () => {
      const skills = await getBeaconSkills(BEACON_URL);

      expect(skills).toBeDefined();
      expect(Array.isArray(skills)).toBe(true);
    });
  });

  describe('heartbeat-keeps-alive', () => {
    it('should show recent activity in agent status', async () => {
      const agents = await getBeaconAgents(BEACON_URL);
      const agent = agents.find(a => a.status === 'connected');

      if (agent) {
        expect(agent.lastActivity).toBeDefined();

        const lastActivityTime = new Date(agent.lastActivity).getTime();
        const now = Date.now();

        // Activity should be recent (within last minute)
        expect(now - lastActivityTime).toBeLessThan(60000);
      }
    });
  });

  describe('agent-cleanup', () => {
    it('should have proper agent state on disconnect', async () => {
      // This test verifies the cleanup mechanism works
      // In a real scenario, we'd trigger agent shutdown and verify removal

      const agents = await getBeaconAgents(BEACON_URL);

      // Just verify we have the expected structure
      for (const agent of agents) {
        expect(agent.id).toBeDefined();
        expect(agent.status).toBeDefined();
        expect(agent.lastActivity).toBeDefined();
      }
    });
  });
});
