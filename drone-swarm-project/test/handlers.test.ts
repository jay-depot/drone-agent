import { describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/board-types.js';
import { makeHandlers } from '../src/handlers.js';
import type { Scheduler } from '../src/scheduler.js';
import type { BoardStore } from '../src/store/board-store.js';
import type { SchedulerStore } from '../src/store/scheduler-store.js';

function makeScheduler() {
  const enqueued: Job[] = [];
  const scheduler = {
    enqueue: async (job: Job) => {
      enqueued.push(job);
    },
    tick: vi.fn(async () => {}),
  } as unknown as Scheduler;
  return { scheduler, enqueued };
}

function makeSchedulerStore(jobs: Job[] = []): SchedulerStore {
  const state = { jobs };
  return {
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
}

/** A minimal in-memory BoardStore with one project, one automation, two columns. */
function makeBoard() {
  const columns = [
    { id: 'col_todo', name: 'Todo', order: 0 },
    { id: 'col_done', name: 'Done', order: 2 },
  ];
  const project = {
    id: 'p_1',
    name: 'Alpha',
    columns,
    cards: [] as Array<{
      id: string;
      title: string;
      columnId: string;
      position: number;
      history: unknown[];
    }>,
    automations: [
      {
        id: 'a_1',
        name: 'to done',
        enabled: true,
        when: { from: '*', to: 'col_done' },
        then: {
          action: 'launch-session' as const,
          personaId: 'code',
          promptTemplate: 'Work on {{card.title}}',
        },
      },
    ],
  };
  const board = {
    listProjects: async () => [{ id: 'p_1', name: 'Alpha', cardCount: 0 }],
    getProject: async (id: string) => (id === 'p_1' ? project : undefined),
    createProject: async () => project,
    updateProject: async () => project,
    deleteProject: async () => true,
    getCard: async (cardId: string) => {
      const card = project.cards.find(c => c.id === cardId);
      return card ? { project, card } : undefined;
    },
    createCard: async (input: { title: string; columnId?: string }) => {
      const card = {
        id: 'c_new',
        title: input.title,
        columnId: input.columnId ?? 'col_todo',
        position: 0,
        history: [],
      };
      project.cards.push(card);
      return card;
    },
    updateCard: async (input: { cardId: string; title?: string }) => {
      const card = project.cards.find(c => c.id === input.cardId);
      if (card && input.title) card.title = input.title;
      return card;
    },
    moveCard: async (input: { cardId: string; toColumnId: string }) => {
      const card = project.cards.find(c => c.id === input.cardId);
      if (!card) return undefined;
      const fromColumnId = card.columnId;
      card.columnId = input.toColumnId;
      return { card, fromColumnId };
    },
    addColumn: async () => columns[0],
    updateColumn: async () => columns[0],
    deleteColumn: async () => true,
    listAutomations: async () => project.automations,
    createAutomation: async () => project.automations[0],
    updateAutomation: async () => project.automations[0],
    deleteAutomation: async () => true,
    setCardSession: async () => undefined,
    getCardProjectId: () => 'p_1',
    getCardIdForSession: (sessionId: string) =>
      sessionId === 'sess-bound' ? 'c_bound' : undefined,
  } as unknown as BoardStore;
  return { board, project };
}

const settings = { injectToolsIntoAllSessions: true };

describe('handlers dispatch', () => {
  it('returns 404 for an unknown capability', async () => {
    const { board } = makeBoard();
    const { scheduler } = makeScheduler();
    const handlers = makeHandlers({
      board,
      scheduler,
      store: makeSchedulerStore(),
      settings,
    });
    const res = await handlers.onInvokeAction!(
      'nope.nope',
      {},
      { caller: 'ui' }
    );
    expect(res.status).toBe(404);
  });

  it('refuses a ui capability for an agent caller', async () => {
    const { board } = makeBoard();
    const { scheduler } = makeScheduler();
    const handlers = makeHandlers({
      board,
      scheduler,
      store: makeSchedulerStore(),
      settings,
    });
    const res = await handlers.onInvokeTool!(
      'limits.get',
      {},
      { caller: 'agent' }
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'CAPABILITY_NOT_AGENT_CALLABLE' });
  });

  it('enqueues exactly one job per matching automation on a move', async () => {
    const { board } = makeBoard();
    const { scheduler, enqueued } = makeScheduler();
    const handlers = makeHandlers({
      board,
      scheduler,
      store: makeSchedulerStore(),
      settings,
    });
    await board.createCard!({
      projectId: 'p_1',
      title: 'Thing',
      actor: 'user',
    });
    const res = await handlers.onInvokeTool!(
      'card.move',
      { projectId: 'p_1', cardId: 'c_new', toColumnId: 'col_done' },
      { caller: 'agent' }
    );
    expect(res.ok).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.prompt).toBe('Work on Thing');
    expect(enqueued[0]?.state).toBe('queued');
  });

  it('enqueues nothing when the move does not match', async () => {
    const { board } = makeBoard();
    const { scheduler, enqueued } = makeScheduler();
    const handlers = makeHandlers({
      board,
      scheduler,
      store: makeSchedulerStore(),
      settings,
    });
    await board.createCard!({
      projectId: 'p_1',
      title: 'Thing',
      actor: 'user',
    });
    const res = await handlers.onInvokeTool!(
      'card.move',
      { projectId: 'p_1', cardId: 'c_new', toColumnId: 'col_todo' },
      { caller: 'agent' }
    );
    expect(res.ok).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it('fills a missing cardId from the bound session', async () => {
    const { board } = makeBoard();
    const { scheduler } = makeScheduler();
    const handlers = makeHandlers({
      board,
      scheduler,
      store: makeSchedulerStore(),
      settings,
    });
    // getCardIdForSession('sess-bound') === 'c_bound'; getCardProjectId → 'p_1'.
    const res = await handlers.onInvokeTool!(
      'card.move',
      { toColumnId: 'col_done' },
      { caller: 'agent', sessionId: 'sess-bound' }
    );
    // The card does not exist in this fixture, so the move 404s — but the
    // binding resolved, so it is not a 400.
    expect(res.status).toBe(404);
  });

  it('treats a card create as a null → column move', async () => {
    const { board } = makeBoard();
    const { scheduler, enqueued } = makeScheduler();
    const handlers = makeHandlers({
      board,
      scheduler,
      store: makeSchedulerStore(),
      settings,
    });
    // Automation is `* → col_done`; creating in col_done should enqueue.
    const res = await handlers.onInvokeTool!(
      'card.create',
      { projectId: 'p_1', title: 'New', columnId: 'col_done' },
      { caller: 'agent' }
    );
    expect(res.ok).toBe(true);
    expect(enqueued).toHaveLength(1);
  });
});
