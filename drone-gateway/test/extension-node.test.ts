import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock('../src/logger.js', () => ({ logger: mockLogger }));

type FakeNode = {
  getFetch: () => (url: string, init?: RequestInit) => Promise<Response>;
  injectFragment: (input: unknown) => void;
  injectTools: (input: unknown) => void;
  removeInjection: (input: unknown) => void;
  stop: () => Promise<void>;
};

const created: Array<{
  opts: Record<string, unknown>;
  node: FakeNode;
  resolve: () => void;
  reject: (err: Error) => void;
}> = [];

vi.mock('drone-swarm-common', () => ({
  createExtensionNode: (opts: Record<string, unknown>) => {
    return new Promise((resolve, reject) => {
      const node: FakeNode = {
        getFetch: () => vi.fn(async () => new Response('ok')),
        injectFragment: vi.fn(),
        injectTools: vi.fn(),
        removeInjection: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      created.push({
        opts,
        node,
        resolve: () => resolve(node),
        reject,
      });
    });
  },
}));

const { ExtensionNodeHandle } = await import('../src/extension-node.js');

const config = {
  id: 'drone-gateway',
  name: 'Drone Gateway',
  dataDir: '/tmp/ext',
  requestTimeoutMs: 15000,
};

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('ExtensionNodeHandle', () => {
  beforeEach(() => {
    created.length = 0;
    vi.clearAllMocks();
  });

  it('is not ready before the node resolves', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    expect(handle.isReady()).toBe(false);
    await handle.stop();
  });

  it('becomes ready once the node resolves', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    created[0].resolve();
    await flush();
    expect(handle.isReady()).toBe(true);
    await handle.stop();
  });

  it('declares the three schedule capabilities and non-blocking registration', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    expect(created[0].opts).toMatchObject({
      coordinatorUrl: 'http://127.0.0.1:3456',
      dataDir: '/tmp/ext',
      id: 'drone-gateway',
      name: 'Drone Gateway',
      awaitRegistration: false,
      requestTimeoutMs: 15000,
    });
    const caps = created[0].opts.capabilities as Array<{ name: string }>;
    expect(caps.map(c => c.name)).toEqual([
      'schedule_wakeup',
      'schedule_list',
      'schedule_cancel',
    ]);
    await handle.stop();
  });

  it('routes an invokeTool command to the installed handler', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    const onInvokeTool = vi.fn(async () => ({ ok: true, status: 200 }));
    handle.setHandlers({
      onSessionStarted: vi.fn(),
      onSessionEnded: vi.fn(),
      onInvokeTool,
    });
    handle.start();
    const handlers = created[0].opts.handlers as {
      onInvokeTool: (
        cap: string,
        params: unknown,
        ctx: { caller: 'agent'; sessionId: string }
      ) => Promise<unknown>;
    };
    const result = await handlers.onInvokeTool(
      'schedule_wakeup',
      { note: 'x' },
      { caller: 'agent', sessionId: 's1' }
    );
    expect(onInvokeTool).toHaveBeenCalledWith(
      'schedule_wakeup',
      { note: 'x' },
      { caller: 'agent', sessionId: 's1' }
    );
    expect(result).toEqual({ ok: true, status: 200 });
    await handle.stop();
  });

  it('rejects an invokeTool command when no handlers are installed', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    const handlers = created[0].opts.handlers as {
      onInvokeTool: (
        cap: string,
        params: unknown,
        ctx: unknown
      ) => Promise<{ ok: boolean; status?: number }>;
    };
    const result = await handlers.onInvokeTool('schedule_wakeup', {}, {});
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    await handle.stop();
  });

  it('forwards session events to the installed handlers', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    const onSessionStarted = vi.fn();
    const onSessionEnded = vi.fn();
    handle.setHandlers({
      onSessionStarted,
      onSessionEnded,
      onInvokeTool: vi.fn(async () => ({ ok: true })),
    });
    handle.start();
    const handlers = created[0].opts.handlers as {
      onSessionStarted: (s: { sessionId: string }) => void;
      onSessionEnded: (e: { sessionId: string }) => void;
    };
    handlers.onSessionStarted({ sessionId: 'a' });
    handlers.onSessionEnded({ sessionId: 'b' });
    expect(onSessionStarted).toHaveBeenCalledWith({ sessionId: 'a' });
    expect(onSessionEnded).toHaveBeenCalledWith({ sessionId: 'b' });
    await handle.stop();
  });

  it('does not throw injecting tools before the node exists', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    expect(() =>
      handle.injectTools({ target: 's1', capabilities: ['schedule_wakeup'] })
    ).not.toThrow();
    expect(() =>
      handle.injectFragment({ target: 's1', id: 'g', content: 'x' })
    ).not.toThrow();
    expect(() =>
      handle.removeInjection({ target: 's1', kind: 'tools' })
    ).not.toThrow();
    await handle.stop();
  });

  it('forwards injections to the node once ready', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    created[0].resolve();
    await flush();
    handle.injectTools({ target: 's1', capabilities: ['schedule_list'] });
    expect(created[0].node.injectTools).toHaveBeenCalledWith({
      target: 's1',
      capabilities: ['schedule_list'],
    });
    await handle.stop();
  });

  it('rejects with a clear error when the node is not connected', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    await expect(handle.fetch('/api/beacons')).rejects.toThrow(
      'coordinator unavailable: gateway extension node not connected'
    );
    await handle.stop();
  });

  it('delegates fetch to the node once ready', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    created[0].resolve();
    await flush();
    const res = await handle.fetch('/api/beacons');
    expect(await res.text()).toBe('ok');
    await handle.stop();
  });

  it('stops a node that resolves after stop() was called', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    const pending = created[0];
    await handle.stop();
    pending.resolve();
    await flush();
    expect(pending.node.stop).toHaveBeenCalled();
    expect(handle.isReady()).toBe(false);
  });

  it('stops the node once and is idempotent', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    created[0].resolve();
    await flush();
    await handle.stop();
    await handle.stop();
    expect(created[0].node.stop).toHaveBeenCalledTimes(1);
  });

  it('logs rather than throws when the node fails to start', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    created[0].reject(new Error('boom'));
    await flush();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Extension node failed: Error: boom'
    );
    expect(handle.isReady()).toBe(false);
    await handle.stop();
  });
});
