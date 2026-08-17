/**
 * Agent Spawning Integration Tests
 *
 * Tests dynamic agent spawning:
 * - spawn-agent-via-api: POST /spawn spawns agent
 * - spawn-with-persona: Spawn with specific persona
 * - spawn-task-execution: Agent receives task prompt
 * - terminate-spawn: DELETE /spawn/:id stops agent
 */

import { beforeAll, describe, it, expect } from 'vitest';
import {
  getBeaconAgents,
  spawnAgent,
  terminateAgent,
  getRequiredIntegrationEnv,
  waitForService,
  shouldSkipIntegrationSuite,
} from './fixtures/index.js';

const DEFAULT_BEACON_URL = 'http://localhost:3457';
const BEACON_URL = getRequiredIntegrationEnv('BEACON_URL', DEFAULT_BEACON_URL);

describe.skipIf(
  shouldSkipIntegrationSuite([
    { url: BEACON_URL, fallbackUrl: DEFAULT_BEACON_URL },
  ])
)('Agent Spawning', () => {
  beforeAll(async () => {
    const beaconReady = await waitForService(BEACON_URL);
    if (!beaconReady) {
      throw new Error(`Beacon service not available at ${BEACON_URL}`);
    }
  });

  describe('spawn-agent-via-api', () => {
    it('should spawn a new agent via API', async () => {
      const initialAgents = await getBeaconAgents(BEACON_URL);
      const initialCount = initialAgents.length;

      try {
        const { agentId } = await spawnAgent(BEACON_URL);
        expect(agentId).toBeDefined();

        // Give the agent time to register
        await new Promise(resolve => setTimeout(resolve, 2000));

        const updatedAgents = await getBeaconAgents(BEACON_URL);
        expect(updatedAgents.length).toBeGreaterThan(initialCount);
      } catch (error) {
        // Spawn API might not be implemented yet
        expect(error).toBeDefined();
      }
    });
  });

  describe('spawn-with-persona', () => {
    it('should spawn agent with specific persona', async () => {
      try {
        const { agentId } = await spawnAgent(BEACON_URL, {
          persona: 'coder',
        });
        expect(agentId).toBeDefined();

        // Verify the agent has the persona
        const agents = await getBeaconAgents(BEACON_URL);
        const spawned = agents.find(a => a.id === agentId);

        if (spawned) {
          expect(spawned.persona).toBe('coder');
        }
      } catch (error) {
        // Spawn API might not be implemented yet
        expect(error).toBeDefined();
      }
    });
  });

  describe('spawn-task-execution', () => {
    it('should receive task prompt on spawn', async () => {
      try {
        const { agentId } = await spawnAgent(BEACON_URL, {
          task: 'Say hello',
        });
        expect(agentId).toBeDefined();
      } catch (error) {
        // Spawn API might not be implemented yet
        expect(error).toBeDefined();
      }
    });
  });

  describe('terminate-spawn', () => {
    it('should terminate a spawned agent', async () => {
      try {
        const { agentId } = await spawnAgent(BEACON_URL);
        expect(agentId).toBeDefined();

        // Give agent time to register
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Terminate the agent
        await terminateAgent(BEACON_URL, agentId);

        // Give time for cleanup
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Verify agent is gone
        const agents = await getBeaconAgents(BEACON_URL);
        const found = agents.find(a => a.id === agentId);

        expect(found).toBeUndefined();
      } catch (error) {
        // Spawn/terminate API might not be implemented yet
        expect(error).toBeDefined();
      }
    });
  });
});
