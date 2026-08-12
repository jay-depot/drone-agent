import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { networkInterfaces } from 'os';
import { setupDb, teardownDb } from './setup.js';
import {
  isLocalConnection,
  isAgentConnected,
  getConnectedAgents,
  getConnection,
  sendToAgent,
  sendToChannel,
} from '../src/ws-server.js';
import { registerAgent } from '../src/db/index.js';

describe('WebSocket Server - IP Validation', () => {
  it('should identify localhost IPv4', () => {
    expect(isLocalConnection('127.0.0.1')).toBe(true);
  });

  it('should identify localhost IPv6', () => {
    expect(isLocalConnection('::1')).toBe(true);
  });

  it('should identify IPv4-mapped IPv6 localhost', () => {
    expect(isLocalConnection('::ffff:127.0.0.1')).toBe(true);
  });

  it('should reject private-LAN IPs (remote beacons not supported)', () => {
    expect(isLocalConnection('192.168.1.1')).toBe(false);
    expect(isLocalConnection('10.0.0.1')).toBe(false);
    expect(isLocalConnection('172.16.0.1')).toBe(false);
    expect(isLocalConnection('169.254.1.1')).toBe(false);
  });

  it('should reject public IPs', () => {
    expect(isLocalConnection('8.8.8.8')).toBe(false);
    expect(isLocalConnection('203.0.113.1')).toBe(false);
  });

  it('should identify the machine\'s own interface addresses', () => {
    const interfaces = networkInterfaces();
    for (const [, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        expect(isLocalConnection(addr.address)).toBe(true);
      }
    }
  });

  it('should handle undefined IP', () => {
    expect(isLocalConnection(undefined)).toBe(false);
  });

  it('should handle empty string', () => {
    expect(isLocalConnection('')).toBe(false);
  });
});

describe('WebSocket Server - Connection Management', () => {
  beforeEach(async () => {
    await setupDb();
    registerAgent({ id: 'agent-1', personaId: null });
    registerAgent({ id: 'agent-2', personaId: null });
  });

  afterEach(async () => {
    // Clean up any connections that were set
    const agents = getConnectedAgents();
    for (const agentId of agents) {
      const conn = getConnection(agentId);
      if (conn) {
        conn.socket.close();
      }
    }
    await teardownDb();
  });

  it('should start with no connected agents', () => {
    expect(getConnectedAgents()).toHaveLength(0);
  });

  it('should report agent as not connected initially', () => {
    expect(isAgentConnected('agent-1')).toBe(false);
  });

  it('should return undefined for non-connected agent', () => {
    expect(getConnection('agent-1')).toBeUndefined();
  });

  it('should send to agent returns false when agent not connected', () => {
    expect(sendToAgent('agent-1', { type: 'test' })).toBe(false);
  });

  it('should send to channel returns 0 when no subscribers', () => {
    expect(sendToChannel('general', { type: 'test' })).toBe(0);
  });
});
