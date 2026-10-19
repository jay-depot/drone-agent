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

  it('passes the config and non-blocking registration to the SDK', async () => {
    const handle = new ExtensionNodeHandle('http://127.0.0.1:3456', config);
    handle.start();
    expect(created[0].opts).toMatchObject({
      coordinatorUrl: 'http://127.0.0.1:3456',
      dataDir: '/tmp/ext',
      id: 'drone-gateway',
      name: 'Drone Gateway',
      capabilities: [],
      awaitRegistration: false,
      requestTimeoutMs: 15000,
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
