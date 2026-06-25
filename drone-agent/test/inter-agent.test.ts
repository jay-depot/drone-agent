/**
 * Inter-Agent Communication Integration Tests
 *
 * Tests the messaging between agents:
 * - send-message-to-agent: Agent A sends message to Agent B
 * - channel-message: Agent posts to channel
 * - message-delivery-status: Read receipts work
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  getBeaconAgents,
  getBeaconMessages,
  sendBeaconMessage,
  joinChannel,
  leaveChannel,
  sendChannelMessage,
  waitForService,
} from '../fixtures/index.js';

const BEACON_URL = process.env.BEACON_URL || 'http://localhost:3457';

describe('Inter-Agent Communication', () => {
  beforeAll(async () => {
    await waitForService(BEACON_URL, 30, 1000);
  });

  describe('send-message-to-agent', () => {
    it('should send a message between agents', async () => {
      const agents = await getBeaconAgents(BEACON_URL);
      
      if (agents.length < 2) {
        // Need at least 2 agents to test messaging
        expect(agents.length).toBeGreaterThanOrEqual(2);
        return;
      }

      const [sender, recipient] = agents;
      
      const message = await sendBeaconMessage(
        BEACON_URL,
        sender.id,
        recipient.id,
        { text: 'Hello from test!' }
      );

      expect(message).toBeDefined();
      expect(message.from).toBe(sender.id);
      expect(message.to).toBe(recipient.id);
    });

    it('should retrieve messages for an agent', async () => {
      const agents = await getBeaconAgents(BEACON_URL);
      
      if (agents.length === 0) {
        expect(agents.length).toBeGreaterThan(0);
        return;
      }

      const messages = await getBeaconMessages(BEACON_URL, agents[0].id);
      expect(messages).toBeDefined();
      expect(Array.isArray(messages)).toBe(true);
    });
  });

  describe('channel-message', () => {
    const testChannel = 'test-channel';

    it('should join a channel', async () => {
      const agents = await getBeaconAgents(BEACON_URL);
      
      if (agents.length === 0) {
        expect(agents.length).toBeGreaterThan(0);
        return;
      }

      // This should not throw
      await expect(
        joinChannel(BEACON_URL, agents[0].id, testChannel)
      ).resolves.not.toThrow();
    });

    it('should post a message to a channel', async () => {
      const agents = await getBeaconAgents(BEACON_URL);
      
      if (agents.length === 0) {
        expect(agents.length).toBeGreaterThan(0);
        return;
      }

      const message = await sendChannelMessage(
        BEACON_URL,
        agents[0].id,
        testChannel,
        { text: 'Channel message test' }
      );

      expect(message).toBeDefined();
      expect(message.channel).toBe(testChannel);
    });

    it('should leave a channel', async () => {
      const agents = await getBeaconAgents(BEACON_URL);
      
      if (agents.length === 0) {
        expect(agents.length).toBeGreaterThan(0);
        return;
      }

      await expect(
        leaveChannel(BEACON_URL, agents[0].id, testChannel)
      ).resolves.not.toThrow();
    });
  });

  describe('message-delivery-status', () => {
    it('should track message delivery status', async () => {
      const agents = await getBeaconAgents(BEACON_URL);
      
      if (agents.length < 2) {
        expect(agents.length).toBeGreaterThanOrEqual(2);
        return;
      }

      const [sender, recipient] = agents;
      
      const message = await sendBeaconMessage(
        BEACON_URL,
        sender.id,
        recipient.id,
        { text: 'Delivery test' }
      );

      // Message should have delivery status
      expect(message.delivered).toBeDefined();
    });
  });
});