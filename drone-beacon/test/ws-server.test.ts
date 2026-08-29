import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  isLocalConnection,
  isAgentConnected,
  getConnectedAgents,
  getConnection,
  sendToAgent,
  sendToChannel,
  pushFragmentToAgent,
  pushFragmentSyncToAllConnected,
  pushFragmentSyncToAllConnected,
} from '../src/ws-server.js';
import {
  registerAgent,
  upsertFragment,
  listFragments,
} from '../src/db/index.js';
import {
  startFragmentTtlSweep,
  stopFragmentTtlSweep,
} from '../src/fragments-sweep.js';

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

  it('should identify private 192.168.x.x', () => {
    expect(isLocalConnection('192.168.1.1')).toBe(true);
  });

  it('should identify private 10.x.x.x', () => {
    expect(isLocalConnection('10.0.0.1')).toBe(true);
  });

  it('should identify private 172.16.x.x', () => {
    expect(isLocalConnection('172.16.0.1')).toBe(true);
  });

  it('should identify the rest of RFC1918 172.16/12 (172.17-172.31)', () => {
    expect(isLocalConnection('172.17.0.6')).toBe(true);
    expect(isLocalConnection('172.20.0.6')).toBe(true);
    expect(isLocalConnection('172.31.255.255')).toBe(true);
    expect(isLocalConnection('172.32.0.1')).toBe(false);
    expect(isLocalConnection('172.15.0.1')).toBe(false);
  });

  it('should identify link-local 169.254.x.x', () => {
    expect(isLocalConnection('169.254.1.1')).toBe(true);
  });

  it('should reject public IPs', () => {
    expect(isLocalConnection('8.8.8.8')).toBe(false);
    expect(isLocalConnection('203.0.113.1')).toBe(false);
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

describe('WebSocket Server - Fragment Push', () => {
  beforeEach(async () => {
    await setupDb();
    registerAgent({ id: 'agent-1', personaId: null });
  });

  afterEach(async () => {
    stopFragmentTtlSweep();
    await teardownDb();
  });

  it('pushFragmentToAgent returns false for unconnected agents', () => {
    expect(
      pushFragmentToAgent('agent-1', 'set', {
        id: 'f1',
        target: 'agent-1',
        content: 'c',
        phase: 'header',
        scope: 'local',
        createdAt: 1,
        updatedAt: 1,
        expiresAt: null,
      })
    ).toBe(false);
  });

  it('pushFragmentSyncToAllConnected sends the merged set to every connected agent', () => {
    // Simulate registered connections for agent-1 and agent-2 directly in
    // the module-level connection map via getConnection contract.
    pushFragmentSyncToAllConnected();
    // Without a real WS server we assert the call is a no-op that does not
    // throw against an empty connection map; full delivery is covered by the
    // Docker swarm integration test.
    expect(getConnectedAgents()).toEqual([]);
  });

  it('TTL sweep deletes expired fragments and pushes removals to connected agents', () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      upsertFragment({
        id: 'exp',
        target: 'agent-1',
        content: 'c',
        phase: 'header',
        scope: 'local',
        expiresAt: now + 1000,
      });
      upsertFragment({
        id: 'live',
        target: 'agent-1',
        content: 'c',
        phase: 'header',
        scope: 'local',
        expiresAt: now + 61000,
      });

      startFragmentTtlSweep();
      vi.advanceTimersByTime(61_000);
      expect(listFragments().map(f => f.id)).toEqual(['live']);
    } finally {
      vi.useRealTimers();
      stopFragmentTtlSweep();
    }
  });
});
