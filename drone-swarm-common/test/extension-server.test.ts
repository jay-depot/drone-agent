import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  sent: string[] = [];
  readyState = FakeWebSocket.OPEN;

  constructor() {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close');
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map(s => JSON.parse(s));
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket }));
vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const captured: {
  urls: string[];
  bodies: unknown[];
  failuresRemaining: number;
  gate: Promise<void> | null;
  fetchArgs: unknown[][];
} = {
  urls: [],
  bodies: [],
  failuresRemaining: 0,
  gate: null,
  fetchArgs: [],
};

vi.mock('../src/coordinator-fetch.js', () => ({
  createCoordinatorFetch: (...args: unknown[]) => {
    captured.fetchArgs.push(args);
    return async (url: string, init?: RequestInit) => {
      if (captured.gate) await captured.gate;
      captured.urls.push(url);
      if (init?.body) captured.bodies.push(JSON.parse(init.body as string));
      if (captured.failuresRemaining > 0) {
        captured.failuresRemaining--;
        return new Response('nope', { status: 503 });
      }
      return new Response(JSON.stringify({ hash: 'deadbeef' }), {
        status: 200,
      });
    };
  },
  buildCheckServerIdentity: () => () => undefined,
}));

const { createExtensionNode } = await import('../src/extension-server.js');

let dataDir: string;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  captured.urls = [];
  captured.bodies = [];
  captured.failuresRemaining = 0;
  captured.gate = null;
  captured.fetchArgs = [];
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'drone-ext-node-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const baseOpts = {
  coordinatorUrl: 'http://127.0.0.1:3456',
  id: 'node-1',
  name: 'Test Node',
  capabilities: [
    {
      name: 'echo',
      description: 'Echo',
      paramSchema: { type: 'object' },
    },
  ],
};

describe('createExtensionNode', () => {
  it('registers with the coordinator and sends a manifest on open', async () => {
    const node = await createExtensionNode({ ...baseOpts, dataDir });
    expect(captured.urls[0]).toBe('http://127.0.0.1:3456/api/beacons');
    expect(captured.bodies[0]).toMatchObject({
      id: 'node-1',
      name: 'Test Node',
      extension: { protocolVersion: 1 },
    });

    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    const manifest = ws.frames().find(f => f.type === 'manifest');
    expect(manifest).toBeDefined();
    expect((manifest!.capabilities as unknown[]).length).toBe(1);

    await node.stop();
  });

  it('dispatches invokeAction to onInvokeAction and replies', async () => {
    const onInvokeAction = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: { echoed: 'hi' },
    });
    const node = await createExtensionNode({
      ...baseOpts,
      dataDir,
      handlers: { onInvokeAction },
    });
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'command',
          id: 'req-1',
          command: 'invokeAction',
          payload: { action: 'echo', params: { q: 'hi' }, caller: 'ui' },
        })
      )
    );
    await new Promise(r => setImmediate(r));

    expect(onInvokeAction).toHaveBeenCalledWith(
      'echo',
      { q: 'hi' },
      {
        caller: 'ui',
        sessionId: undefined,
      }
    );
    const reply = ws.frames().find(f => f.type === 'response');
    expect(reply).toMatchObject({
      id: 'req-1',
      ok: true,
      status: 200,
      body: { echoed: 'hi' },
    });
    await node.stop();
  });

  it('dispatches invokeTool to onInvokeTool', async () => {
    const onInvokeTool = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const node = await createExtensionNode({
      ...baseOpts,
      dataDir,
      handlers: { onInvokeTool },
    });
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'command',
          id: 'req-2',
          command: 'invokeTool',
          payload: {
            action: 'echo',
            params: { q: 'x' },
            caller: 'agent',
            sessionId: 'sess-1',
          },
        })
      )
    );
    await new Promise(r => setImmediate(r));
    expect(onInvokeTool).toHaveBeenCalledWith(
      'echo',
      { q: 'x' },
      {
        caller: 'agent',
        sessionId: 'sess-1',
      }
    );
    await node.stop();
  });

  it('dispatches session events to handlers', async () => {
    const onSessionStarted = vi.fn();
    const onSessionEnded = vi.fn();
    const node = await createExtensionNode({
      ...baseOpts,
      dataDir,
      handlers: { onSessionStarted, onSessionEnded },
    });
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'event',
          event: 'sessionStarted',
          session: { sessionId: 's1' },
        })
      )
    );
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'event',
          event: 'sessionEnded',
          session: { sessionId: 's1' },
        })
      )
    );
    await new Promise(r => setImmediate(r));
    expect(onSessionStarted).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(onSessionEnded).toHaveBeenCalledWith({ sessionId: 's1' });
    await node.stop();
  });

  it('emits inject / inject-remove frames', async () => {
    const node = await createExtensionNode({ ...baseOpts, dataDir });
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.sent = [];

    node.injectFragment({
      target: 's1',
      id: 'frag-1',
      content: '# Hello',
    });
    node.injectReminder({ target: 's1', id: 'rem-1', content: 'Note' });
    node.injectTools({ target: 's1', capabilities: ['echo'] });
    node.removeInjection({
      target: 's1',
      kind: 'fragment',
      injectionId: 'frag-1',
    });

    const frames = ws.frames();
    expect(frames[0]).toMatchObject({
      type: 'inject',
      id: 'frag-1',
      target: 's1',
      kind: 'fragment',
      content: '# Hello',
      phase: 'header',
    });
    expect(frames[1]).toMatchObject({ type: 'inject', kind: 'reminder' });
    expect(frames[2]).toMatchObject({
      type: 'inject',
      kind: 'tools',
      tools: [{ capability: 'echo' }],
    });
    expect(frames[3]).toMatchObject({
      type: 'inject-remove',
      kind: 'fragment',
      injectionId: 'frag-1',
    });
    await node.stop();
  });

  it('uploads a bundle over HTTP', async () => {
    const node = await createExtensionNode({ ...baseOpts, dataDir });
    const result = await node.uploadBundle({
      name: 'panel',
      version: '1.0.0',
      files: [{ name: 'index.js', contentBase64: 'AA==' }],
    });
    expect(result.hash).toBe('deadbeef');
    expect(captured.urls.at(-1)).toContain('/api/extensions/bundles/panel');
    await node.stop();
  });

  it('re-declares the manifest dynamically', async () => {
    const node = await createExtensionNode({ ...baseOpts, dataDir });
    const ws = FakeWebSocket.instances[0];
    ws.emit('open');
    ws.sent = [];
    node.declareManifest({
      protocolVersion: 1,
      capabilities: [{ name: 'new', description: 'n', paramSchema: {} }],
      bundles: [],
    });
    const manifest = ws.frames().find(f => f.type === 'manifest');
    expect((manifest!.capabilities as Array<{ name: string }>)[0].name).toBe(
      'new'
    );
    await node.stop();
  });

  it('reconnects after a close', async () => {
    vi.useFakeTimers();
    const node = await createExtensionNode({ ...baseOpts, dataDir });
    const first = FakeWebSocket.instances[0];
    first.emit('open');
    first.close();
    vi.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    await node.stop();
    vi.useRealTimers();
  });

  it('resolves before registration when awaitRegistration is false', async () => {
    let releaseGate: () => void = () => {};
    captured.gate = new Promise<void>(resolve => {
      releaseGate = resolve;
    });

    const node = await createExtensionNode({
      ...baseOpts,
      dataDir,
      awaitRegistration: false,
    });

    expect(captured.bodies).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(0);

    releaseGate();
    await new Promise(r => setImmediate(r));

    expect(captured.bodies[0]).toMatchObject({ id: 'node-1' });
    expect(FakeWebSocket.instances).toHaveLength(1);
    await node.stop();
  });

  it('retries registration in the background until it succeeds', async () => {
    vi.useFakeTimers();
    captured.failuresRemaining = 2;

    const node = await createExtensionNode({
      ...baseOpts,
      dataDir,
      awaitRegistration: false,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(captured.urls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(captured.urls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(captured.urls).toHaveLength(3);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60000);
    expect(captured.urls).toHaveLength(3);

    await node.stop();
    vi.useRealTimers();
  });

  it('does not connect when stopped during registration retry', async () => {
    vi.useFakeTimers();
    captured.failuresRemaining = 5;

    const node = await createExtensionNode({
      ...baseOpts,
      dataDir,
      awaitRegistration: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(captured.urls).toHaveLength(1);

    await node.stop();
    await vi.advanceTimersByTimeAsync(120000);

    expect(captured.urls).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
    vi.useRealTimers();
  });

  it('passes requestTimeoutMs to the coordinator fetch', async () => {
    const node = await createExtensionNode({
      ...baseOpts,
      dataDir,
      requestTimeoutMs: 1234,
    });
    expect(captured.fetchArgs[0][4]).toBe(1234);
    await node.stop();
  });
});
