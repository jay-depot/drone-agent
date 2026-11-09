import { describe, expect, it, vi } from 'vitest';
import type { Job, Limits, Project } from '../src/board-types.js';
import { Scheduler, intervalMs } from '../src/scheduler.js';
import type { BoardStore } from '../src/store/board-store.js';
import type { SchedulerStore } from '../src/store/scheduler-store.js';

const DAY = 24 * 60 * 60 * 1000;

function makeStore(limits: Limits, jobs: Job[] = []) {
  const state = { limits, jobs };
  const store: SchedulerStore = {
    getLimits: async () => ({ ...state.limits }),
    setLimits: async patch => {
      state.limits = { ...state.limits, ...patch };
      return { ...state.limits };
    },
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
  return { store, state };
}

function makeBoard(): BoardStore {
  const project: Project = {
    id: 'p_1',
    name: 'Alpha',
    columns: [],
    cards: [],
    automations: [],
  };
  return {
    getProject: async (id: string) => (id === 'p_1' ? project : undefined),
    getCard: async () => undefined,
    setCardSession: async () => undefined,
  } as unknown as BoardStore;
}

function job(id: string, createdAt: number, extra: Partial<Job> = {}): Job {
  return {
    id,
    projectId: 'p_1',
    cardId: `c_${id}`,
    ruleId: 'a_1',
    prompt: 'do it',
    state: 'queued',
    createdAt,
    ...extra,
  };
}

describe('intervalMs', () => {
  it('is 24h / maxDailySessions', () => {
    expect(intervalMs({ maxConcurrentSessions: 1, maxDailySessions: 12 })).toBe(
      DAY / 12
    );
  });

  it('is zero when the daily cap is non-positive', () => {
    expect(intervalMs({ maxConcurrentSessions: 1, maxDailySessions: 0 })).toBe(
      0
    );
  });
});

describe('Scheduler.tick gates', () => {
  it('starts the oldest queued job first', async () => {
    const { store, state } = makeStore(
      { maxConcurrentSessions: 5, maxDailySessions: 12 },
      [job('j_new', 2000), job('j_old', 1000)]
    );
    const spawn = vi.fn(async (_job: Job, _project: Project) => ({
      spawnId: 's',
      agentId: 'a',
    }));
    const scheduler = new Scheduler({
      store,
      board: makeBoard(),
      spawn,
      now: () => 0,
    });
    await scheduler.tick();
    expect(spawn.mock.calls[0]?.[0].id).toBe('j_old');
    expect(state.jobs.find(j => j.id === 'j_old')?.state).toBe('running');
  });

  it('blocks on the concurrency gate', async () => {
    const { store } = makeStore(
      { maxConcurrentSessions: 1, maxDailySessions: 12 },
      [
        job('j_run', 0, { state: 'running', startedAt: 0 }),
        job('j_queued', 1000),
      ]
    );
    const spawn = vi.fn(async (_job: Job, _project: Project) => ({
      spawnId: 's',
      agentId: 'a',
    }));
    await new Scheduler({
      store,
      board: makeBoard(),
      spawn,
      now: () => 0,
    }).tick();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('blocks on the daily cap', async () => {
    const jobs: Job[] = [];
    for (let i = 0; i < 12; i++) {
      jobs.push(job(`j_${i}`, i, { state: 'done', startedAt: DAY - 1 }));
    }
    jobs.push(job('j_queued', DAY));
    const { store } = makeStore(
      { maxConcurrentSessions: 5, maxDailySessions: 12 },
      jobs
    );
    const spawn = vi.fn(async (_job: Job, _project: Project) => ({
      spawnId: 's',
      agentId: 'a',
    }));
    await new Scheduler({
      store,
      board: makeBoard(),
      spawn,
      now: () => DAY,
    }).tick();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('blocks on the spacing gate', async () => {
    const { store } = makeStore(
      { maxConcurrentSessions: 5, maxDailySessions: 12 },
      [
        job('j_prev', 0, { state: 'done', startedAt: 1000 }),
        job('j_queued', 1500),
      ]
    );
    const spawn = vi.fn(async (_job: Job, _project: Project) => ({
      spawnId: 's',
      agentId: 'a',
    }));
    await new Scheduler({
      store,
      board: makeBoard(),
      spawn,
      now: () => 1000 + DAY / 12 - 1,
    }).tick();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('prunes the daily window on read with an injected clock', async () => {
    const { store } = makeStore(
      { maxConcurrentSessions: 5, maxDailySessions: 1 },
      [job('j_old', 0, { state: 'done', startedAt: 1 }), job('j_queued', 10)]
    );
    const spawn = vi.fn(async (_job: Job, _project: Project) => ({
      spawnId: 's',
      agentId: 'a',
    }));
    await new Scheduler({
      store,
      board: makeBoard(),
      spawn,
      now: () => DAY + 2,
    }).tick();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('marks a job failed when the spawn throws', async () => {
    const { store, state } = makeStore(
      { maxConcurrentSessions: 5, maxDailySessions: 12 },
      [job('j_1', 0)]
    );
    const scheduler = new Scheduler({
      store,
      board: makeBoard(),
      spawn: async () => {
        throw new Error('boom');
      },
      now: () => 0,
    });
    await scheduler.tick();
    const failed = state.jobs.find(j => j.id === 'j_1');
    expect(failed?.state).toBe('failed');
    expect(failed?.error).toBe('boom');
  });
});

describe('Scheduler.reconcile', () => {
  it('fails a stale running job', async () => {
    const { store, state } = makeStore(
      { maxConcurrentSessions: 1, maxDailySessions: 12 },
      [job('j_1', 0, { state: 'running', startedAt: 0 })]
    );
    const scheduler = new Scheduler({
      store,
      board: makeBoard(),
      spawn: vi.fn(),
      now: () => 5000,
    });
    await scheduler.reconcile(['j_1']);
    const stale = state.jobs.find(j => j.id === 'j_1');
    expect(stale?.state).toBe('failed');
    expect(stale?.error).toBe('session not found after restart');
  });
});
