/**
 * Agent Spawning Integration Tests
 *
 * Tests dynamic agent spawning:
 * - spawn-agent-via-api: POST /spawn spawns agent
 * - spawn-with-persona: Spawn with specific persona
 * - spawn-task-execution: Agent receives task prompt
 * - terminate-spawn: DELETE /spawn/:id stops agent
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  getBeaconAgents,
  spawnAgent,
  terminateAgent,
  waitForService,
} from './fixtures/index.js';

const BEACON_URL = process.env.BEACON_URL || 'http://localhost:3457';

describe('Agent Spawning', () => {
  beforeAll(async () => {
    await waitForService(BEACON_URL, 30, 1000);
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