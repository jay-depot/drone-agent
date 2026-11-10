import { describe, expect, it, vi } from 'vitest';
import {
  ScheduleService,
  findConversationAdapter,
  type ScheduleNodeHandle,
} from '../src/schedule/service.js';
import type { DroneSessionSnapshot } from 'drone-core';
import type { ScheduledWakeupStore } from '../src/store/gateway-state-store.js';
import type { ResolvedServiceAdapter } from '../src/types.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
};

function makeStore(): ScheduledWakeupStore & {
  rows: Map<
    string,
    {
      id: string;
      conversationId: string;
      note: string;
      dueAt: number;
      createdAt: number;
      attempts: number;
    }
  >;
} {
  const rows = new Map<
    string,
    {
      id: string;
      conversationId: string;
      note: string;
      dueAt: number;
      createdAt: number;
      attempts: number;
    }
  >();
  return {
    rows,
    insert(input) {
      rows.set(input.id, {
        ...input,
        createdAt: Date.now(),
        attempts: 0,
      });
    },
    list(conversationId) {
      return [...rows.values()].filter(
        r => r.conversationId === conversationId
      );
    },
    get(id) {
      return rows.get(id) ?? null;
    },
    due(conversationId, now) {
      return [...rows.values()].filter(
        r => r.conversationId === conversationId && r.dueAt <= now
      );
    },
    remove(id) {
      rows.delete(id);
    },
    bumpAttempts(id) {
      const row = rows.get(id);
      if (!row) return 0;
      row.attempts += 1;
      return row.attempts;
    },
  };
}

function makeSnapshot(
  overrides: Partial<DroneSessionSnapshot> = {}
): DroneSessionSnapshot {
  return {
    protocolVersion: 1,
    sessionId: 's1',
    personaId: 'coder',
    beaconId: 'b1',
    interactive: false,
    isSubagent: false,
    cwd: '/tmp',
    enabledPlugins: [],
    mountedTools: [],
    extensionHint: 'drone-gateway:conv-1',
    ...overrides,
  };
}

function makeService(opts: {
  store?: ScheduledWakeupStore;
  adapters?: ResolvedServiceAdapter[];
  node?: ScheduleNodeHandle | undefined;
}) {
  const store = opts.store;
  const adapters = opts.adapters ?? [
    {
      id: 'matrix-1',
      type: 'matrix',
      config: {},
      conversations: new Map([['conv-1', { surfaces: [] }]]),
    },
  ];
  const service = new ScheduleService({
    getNode: () => opts.node,
    getWakeupStore: () => store,
    resolveAdapter: conversationId =>
      findConversationAdapter(adapters, conversationId),
    logger,
    extensionId: 'drone-gateway',
  });
  service.setEnabledConversations(new Set(['conv-1']));
  return service;
}

describe('ScheduleService', () => {
  it('injects tools and the guidance fragment for an enabled conversation', () => {
    const node = { injectTools: vi.fn(), injectFragment: vi.fn() };
    const service = makeService({ store: makeStore(), node });
    service.registerSession(makeSnapshot());
    expect(node.injectTools).toHaveBeenCalledWith({
      target: 's1',
      capabilities: ['schedule_wakeup', 'schedule_list', 'schedule_cancel'],
    });
    expect(node.injectFragment).toHaveBeenCalledWith({
      target: 's1',
      id: 'schedule-guidance',
      content: expect.stringContaining('# Scheduled Wake-ups'),
    });
  });

  it('ignores a session whose hint does not match the extension id', () => {
    const node = { injectTools: vi.fn(), injectFragment: vi.fn() };
    const service = makeService({ store: makeStore(), node });
    service.registerSession(
      makeSnapshot({ extensionHint: 'other-ext:conv-1' })
    );
    expect(node.injectTools).not.toHaveBeenCalled();
    expect(service.isReady('conv-1')).toBe(false);
  });

  it('ignores a session for a disabled conversation', () => {
    const node = { injectTools: vi.fn(), injectFragment: vi.fn() };
    const service = makeService({ store: makeStore(), node });
    service.registerSession(
      makeSnapshot({ extensionHint: 'drone-gateway:conv-2' })
    );
    expect(node.injectTools).not.toHaveBeenCalled();
    expect(service.isReady('conv-2')).toBe(false);
  });

  it('ignores a session with no extension hint', () => {
    const node = { injectTools: vi.fn(), injectFragment: vi.fn() };
    const service = makeService({ store: makeStore(), node });
    service.registerSession(makeSnapshot({ extensionHint: undefined }));
    expect(node.injectTools).not.toHaveBeenCalled();
  });

  it('isReady is true once the conversation has a registered session', () => {
    const node = { injectTools: vi.fn(), injectFragment: vi.fn() };
    const service = makeService({ store: makeStore(), node });
    expect(service.isReady('conv-1')).toBe(false);
    service.registerSession(makeSnapshot());
    expect(service.isReady('conv-1')).toBe(true);
    service.unregisterSession({ sessionId: 's1' });
    expect(service.isReady('conv-1')).toBe(false);
  });

  it('warns and does not register when the adapter is ambiguous', () => {
    const node = { injectTools: vi.fn(), injectFragment: vi.fn() };
    const adaptersA: ResolvedServiceAdapter = {
      id: 'a',
      type: 'matrix',
      config: {},
      conversations: new Map([['conv-1', { surfaces: [] }]]),
    };
    const adaptersB: ResolvedServiceAdapter = { ...adaptersA, id: 'b' };
    const service = makeService({
      store: makeStore(),
      node,
      adapters: [adaptersA, adaptersB],
    });
    service.registerSession(makeSnapshot());
    expect(logger.warn).toHaveBeenCalled();
    expect(node.injectTools).not.toHaveBeenCalled();
  });

  it('inserts a wake-up and returns the resolved instant', async () => {
    const store = makeStore();
    const service = makeService({
      store,
      node: { injectTools: vi.fn(), injectFragment: vi.fn() },
    });
    service.registerSession(makeSnapshot());
    const dueAt = '2030-01-02T03:04:05.000Z';
    const result = await service.handleInvokeTool(
      'schedule_wakeup',
      { note: 'soup', dueAt },
      { caller: 'agent', sessionId: 's1' }
    );
    expect(result.ok).toBe(true);
    expect(result.body).toMatchObject({
      dueAt: Date.parse(dueAt),
    });
    expect(store.rows.size).toBe(1);
  });

  it('returns a 400 for a bad time', async () => {
    const service = makeService({
      store: makeStore(),
      node: { injectTools: vi.fn(), injectFragment: vi.fn() },
    });
    service.registerSession(makeSnapshot());
    const result = await service.handleInvokeTool(
      'schedule_wakeup',
      { note: 'soup', dueAt: 'nope' },
      { caller: 'agent', sessionId: 's1' }
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('returns a 400 when the note is missing', async () => {
    const service = makeService({
      store: makeStore(),
      node: { injectTools: vi.fn(), injectFragment: vi.fn() },
    });
    service.registerSession(makeSnapshot());
    const result = await service.handleInvokeTool(
      'schedule_wakeup',
      { delayMs: 1000 },
      { caller: 'agent', sessionId: 's1' }
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('lists and cancels wake-ups', async () => {
    const store = makeStore();
    store.insert({ id: 'w1', conversationId: 'conv-1', note: 'a', dueAt: 1 });
    const service = makeService({
      store,
      node: { injectTools: vi.fn(), injectFragment: vi.fn() },
    });
    service.registerSession(makeSnapshot());

    const listed = await service.handleInvokeTool(
      'schedule_list',
      {},
      { caller: 'agent', sessionId: 's1' }
    );
    expect(listed.ok).toBe(true);
    expect(listed.body).toHaveLength(1);

    const cancelled = await service.handleInvokeTool(
      'schedule_cancel',
      { id: 'w1' },
      { caller: 'agent', sessionId: 's1' }
    );
    expect(cancelled).toMatchObject({ ok: true, body: { cancelled: true } });
    expect(store.rows.size).toBe(0);
  });

  it('cancelling a missing id reports cancelled:false', async () => {
    const service = makeService({
      store: makeStore(),
      node: { injectTools: vi.fn(), injectFragment: vi.fn() },
    });
    service.registerSession(makeSnapshot());
    const result = await service.handleInvokeTool(
      'schedule_cancel',
      { id: 'nope' },
      { caller: 'agent', sessionId: 's1' }
    );
    expect(result).toMatchObject({ ok: true, body: { cancelled: false } });
  });

  it('returns a 400 for an unknown session', async () => {
    const service = makeService({
      store: makeStore(),
      node: { injectTools: vi.fn(), injectFragment: vi.fn() },
    });
    const result = await service.handleInvokeTool(
      'schedule_wakeup',
      { note: 'x', delayMs: 1 },
      { caller: 'agent', sessionId: 'unknown' }
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it('returns a 503 for schedule_wakeup when there is no store', async () => {
    const service = makeService({
      store: undefined,
      node: { injectTools: vi.fn(), injectFragment: vi.fn() },
    });
    service.registerSession(makeSnapshot());
    const result = await service.handleInvokeTool(
      'schedule_wakeup',
      { note: 'x', delayMs: 1 },
      { caller: 'agent', sessionId: 's1' }
    );
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it('returns a 404 for an unknown capability', async () => {
    const service = makeService({
      store: makeStore(),
      node: { injectTools: vi.fn(), injectFragment: vi.fn() },
    });
    service.registerSession(makeSnapshot());
    const result = await service.handleInvokeTool(
      'nope',
      {},
      { caller: 'agent', sessionId: 's1' }
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it('does not register when the node is absent', () => {
    const service = makeService({ store: makeStore(), node: undefined });
    service.registerSession(makeSnapshot());
    expect(service.isReady('conv-1')).toBe(false);
  });
});

describe('findConversationAdapter', () => {
  function adapter(
    id: string,
    conversationIds: string[]
  ): ResolvedServiceAdapter {
    return {
      id,
      type: 'matrix',
      config: {},
      conversations: new Map(conversationIds.map(c => [c, { surfaces: [] }])),
    };
  }

  it('finds the single adapter declaring a conversation', () => {
    expect(
      findConversationAdapter([adapter('a', ['conv-1'])], 'conv-1')
    ).toEqual({ adapterId: 'a', ambiguous: false });
  });

  it('reports ambiguity when two adapters declare it', () => {
    expect(
      findConversationAdapter(
        [adapter('a', ['conv-1']), adapter('b', ['conv-1'])],
        'conv-1'
      )
    ).toEqual({ adapterId: 'a', ambiguous: true });
  });

  it('returns undefined when no adapter declares it', () => {
    expect(
      findConversationAdapter([adapter('a', ['conv-2'])], 'conv-1')
    ).toBeUndefined();
  });
});
