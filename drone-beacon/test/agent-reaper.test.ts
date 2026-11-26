import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { AgentSession } from '../src/types.js';

vi.mock('../src/db/index.js', () => ({
  listAgents: vi.fn(() => []),
}));

vi.mock('../src/ws-server.js', () => ({
  getConnectedAgents: vi.fn(() => []),
}));

vi.mock('../src/agent-removal.js', () => ({
  removeAgent: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db/index.js');
const agentRemoval = await import('../src/agent-removal.js');
const { reapStaleAgents, startAgentReaper, stopAgentReaper } =
  await import('../src/agent-reaper.js');

function agent(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'agent-1',
    personaId: null,
    status: 'connected',
    connectedAt: 0,
    lastActivity: 0,
    ...overrides,
  };
}

describe('reapStaleAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.listAgents).mockReturnValue([]);
    vi.mocked(agentRemoval.removeAgent).mockResolvedValue({
      removed: true,
      agent: undefined,
    });
  });

  it('deletes a row with no socket and an old lastActivity', async () => {
    vi.mocked(db.listAgents).mockReturnValue([
      agent({ id: 'agent-1', lastActivity: 0 }),
    ]);

    const reaped = await reapStaleAgents(Date.now(), new Set<string>(), 45_000);

    expect(agentRemoval.removeAgent).toHaveBeenCalledWith('agent-1');
    expect(reaped).toEqual(['agent-1']);
  });

  it('keeps a row with an open socket', async () => {
    vi.mocked(db.listAgents).mockReturnValue([
      agent({ id: 'agent-1', lastActivity: 0 }),
    ]);

    const reaped = await reapStaleAgents(
      Date.now(),
      new Set(['agent-1']),
      45_000
    );

    expect(agentRemoval.removeAgent).not.toHaveBeenCalled();
    expect(reaped).toEqual([]);
  });

  it('keeps a row with a fresh heartbeat', async () => {
    const now = 1_000_000;
    vi.mocked(db.listAgents).mockReturnValue([
      agent({ id: 'agent-1', lastActivity: now - 1000 }),
    ]);

    const reaped = await reapStaleAgents(now, new Set<string>(), 45_000);

    expect(agentRemoval.removeAgent).not.toHaveBeenCalled();
    expect(reaped).toEqual([]);
  });

  it('keeps a row one tick inside the grace and reaps one exactly at it', async () => {
    const now = 1_000_000;
    const graceMs = 45_000;
    vi.mocked(db.listAgents).mockReturnValue([
      agent({ id: 'kept', lastActivity: now - (graceMs - 1) }),
      agent({ id: 'reaped', lastActivity: now - graceMs }),
    ]);

    const reaped = await reapStaleAgents(now, new Set<string>(), graceMs);

    expect(agentRemoval.removeAgent).toHaveBeenCalledTimes(1);
    expect(agentRemoval.removeAgent).toHaveBeenCalledWith('reaped');
    expect(reaped).toEqual(['reaped']);
  });

  it('does not report a row when removeAgent removed nothing', async () => {
    vi.mocked(db.listAgents).mockReturnValue([
      agent({ id: 'agent-1', lastActivity: 0 }),
    ]);
    vi.mocked(agentRemoval.removeAgent).mockResolvedValue({
      removed: false,
      agent: undefined,
    });

    const reaped = await reapStaleAgents(1_000_000, new Set<string>(), 45_000);

    expect(reaped).toEqual([]);
  });
});

describe('startAgentReaper / stopAgentReaper', () => {
  afterEach(() => {
    stopAgentReaper();
    vi.restoreAllMocks();
  });

  it('is idempotent: a second call returns the same timer', () => {
    const first = startAgentReaper(1000);
    const second = startAgentReaper(1000);
    expect(second).toBe(first);
  });

  it('unrefs the timer', () => {
    const unref = vi.fn();
    const handle = { unref } as unknown as NodeJS.Timeout;
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(handle);

    startAgentReaper(1000);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('clears the timer on stop', () => {
    const handle = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(handle);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    startAgentReaper(1000);
    stopAgentReaper();

    expect(clearSpy).toHaveBeenCalledWith(handle);
  });
});
