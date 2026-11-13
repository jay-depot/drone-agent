import { describe, expect, it, vi } from 'vitest';
import type { DroneSessionSnapshot } from 'drone-core';
import type { Job } from '../src/board-types.js';
import { makeSessionHandlers } from '../src/session-events.js';
import type { ReconcileTracker } from '../src/scheduler-reconcile.js';
import type { Scheduler } from '../src/scheduler.js';
import type { BoardStore } from '../src/store/board-store.js';
import type { SchedulerStore } from '../src/store/scheduler-store.js';

function snapshot(
  overrides: Partial<DroneSessionSnapshot> = {}
): DroneSessionSnapshot {
  return {
    protocolVersion: 1,
    sessionId: 'sess-1',
    personaId: 'code',
    beaconId: 'b_1',
    interactive: false,
    isSubagent: false,
    cwd: '/tmp',
    enabledPlugins: [],
    mountedTools: [],
    ...overrides,
  };
}

function makeStores(jobs: Job[] = []) {
  const state = { jobs };
  const store: SchedulerStore = {
    getLimits: async () => ({ maxConcurrentSessions: 1, maxDailySessions: 12 }),
    setLimits: async () => ({ maxConcurrentSessions: 1, maxDailySessions: 12 }),
    listJobs: async () => state.jobs.map(j => ({ ...j })),
    enqueueJob: async job => {
      state.jobs.push(job);
    },
    updateJob: async (jobId, patch) => {
      const job = state.jobs.find(j => j.id === jobId);
      if (!job) return undefined;
      Object.assign(job, patch);
      return { ...job };
    },
  };
  const card = {
    id: 'c_1',
    title: 'Thing',
    columnId: 'col',
    position: 0,
    history: [],
  };
  const project = {
    id: 'p_1',
    name: 'Alpha',
    columns: [{ id: 'col', name: 'Todo', order: 0 }],
    cards: [card],
    automations: [],
  };
  const board = {
    getCard: async (cardId: string) =>
      cardId === 'c_1' ? { project, card } : undefined,
    setCardSession: vi.fn(async () => card),
  } as unknown as BoardStore;
  return {
    store,
    board,
    state,
    setCardSession: board.setCardSession as ReturnType<typeof vi.fn>,
  };
}

function baseJob(extra: Partial<Job> = {}): Job {
  return {
    id: 'j_1',
    projectId: 'p_1',
    cardId: 'c_1',
    ruleId: 'a_1',
    prompt: 'do the thing',
    state: 'running',
    createdAt: 0,
    agentId: 'sess-1',
    ...extra,
  };
}

function makeTracker(): ReconcileTracker {
  return { confirm: vi.fn() } as unknown as ReconcileTracker;
}

const settings = { injectToolsIntoAllSessions: true };

describe('onSessionStarted', () => {
  it('instructs a job, records the session, injects tools and the fragment', async () => {
    const { store, board, setCardSession } = makeStores([baseJob()]);
    const injectTools = vi.fn();
    const injectFragment = vi.fn();
    const instruct = vi.fn(async () => true);
    const confirm = vi.fn();
    const handlers = makeSessionHandlers({
      store,
      board,
      getNode: () => ({ injectTools, injectFragment }) as never,
      instruct,
      settings,
      reconcile: { confirm } as unknown as ReconcileTracker,
      scheduler: { tick: vi.fn() } as unknown as Scheduler,
    });

    await handlers.onSessionStarted!(
      snapshot({ extensionHint: 'drone-swarm-project:card:c_1' })
    );

    expect(instruct).toHaveBeenCalledWith('sess-1', 'do the thing');
    expect(setCardSession).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith('j_1');
    expect(injectTools).toHaveBeenCalledWith({
      target: 'sess-1',
      capabilities: expect.any(Array),
    });
    expect(injectFragment).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'sess-1', id: 'card-binding' })
    );
  });

  it('injects tools only for a non-card top-level session', async () => {
    const { store, board } = makeStores();
    const injectTools = vi.fn();
    const injectFragment = vi.fn();
    const handlers = makeSessionHandlers({
      store,
      board,
      getNode: () => ({ injectTools, injectFragment }) as never,
      instruct: vi.fn(),
      settings,
      reconcile: makeTracker(),
      scheduler: { tick: vi.fn() } as unknown as Scheduler,
    });

    await handlers.onSessionStarted!(snapshot());

    expect(injectTools).toHaveBeenCalledOnce();
    expect(injectFragment).not.toHaveBeenCalled();
  });

  it('injects nothing for a subagent session', async () => {
    const { store, board } = makeStores();
    const injectTools = vi.fn();
    const injectFragment = vi.fn();
    const handlers = makeSessionHandlers({
      store,
      board,
      getNode: () => ({ injectTools, injectFragment }) as never,
      instruct: vi.fn(),
      settings,
      reconcile: makeTracker(),
      scheduler: { tick: vi.fn() } as unknown as Scheduler,
    });

    await handlers.onSessionStarted!(
      snapshot({
        isSubagent: true,
        extensionHint: 'drone-swarm-project:card:c_1',
      })
    );

    expect(injectTools).not.toHaveBeenCalled();
    expect(injectFragment).not.toHaveBeenCalled();
  });

  it('injects nothing when injectToolsIntoAllSessions is false', async () => {
    const { store, board } = makeStores();
    const injectTools = vi.fn();
    const handlers = makeSessionHandlers({
      store,
      board,
      getNode: () => ({ injectTools, injectFragment: vi.fn() }) as never,
      instruct: vi.fn(),
      settings: { injectToolsIntoAllSessions: false },
      reconcile: makeTracker(),
      scheduler: { tick: vi.fn() } as unknown as Scheduler,
    });

    await handlers.onSessionStarted!(snapshot());

    expect(injectTools).not.toHaveBeenCalled();
  });
});

describe('onSessionEnded', () => {
  it('closes the job to done, sets the card status, and ticks', async () => {
    const { store, board, state, setCardSession } = makeStores([
      baseJob({ sessionId: 'sess-1' }),
    ]);
    const tick = vi.fn(async () => {});
    const handlers = makeSessionHandlers({
      store,
      board,
      getNode: () =>
        ({ injectTools: vi.fn(), injectFragment: vi.fn() }) as never,
      instruct: vi.fn(),
      settings,
      reconcile: makeTracker(),
      scheduler: { tick } as unknown as Scheduler,
    });

    await handlers.onSessionEnded!({ sessionId: 'sess-1' });

    expect(state.jobs[0]?.state).toBe('done');
    expect(setCardSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionStatus: 'ended' })
    );
    expect(tick).toHaveBeenCalledOnce();
  });

  it('does nothing when no running job matches', async () => {
    const { store, board } = makeStores([]);
    const handlers = makeSessionHandlers({
      store,
      board,
      getNode: () =>
        ({ injectTools: vi.fn(), injectFragment: vi.fn() }) as never,
      instruct: vi.fn(),
      settings,
      reconcile: makeTracker(),
      scheduler: { tick: vi.fn() } as unknown as Scheduler,
    });
    await handlers.onSessionEnded!({ sessionId: 'unknown' });
    expect(store.listJobs).toBeDefined();
  });
});
