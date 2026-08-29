import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// The spawn/message handlers run against the real database layer, so stub
// the handler modules and observe dispatch + response shaping instead.
vi.mock('../src/routes/spawn-handlers.js', () => ({
  handleSpawnAgent: vi.fn(),
  handleListSpawns: vi.fn(),
  handleGetSpawn: vi.fn(),
  handleTerminateSpawn: vi.fn(),
}));

vi.mock('../src/routes/message-handlers.js', () => ({
  handleDeliverMessage: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Capture the WebSocket instances the client constructs so tests can drive
 * the message loop. Declared before the dynamic imports below because the
 * `ws` mock factory closes over it and runs when coordinator-ws.js first
 * imports 'ws'.
 */
class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
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
    this.readyState = 3;
    this.emit('close');
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket }));

const { handleSpawnAgent } = await import('../src/routes/spawn-handlers.js');
const { startCoordinatorWsClient, resetCoordinatorWsClient } = await import(
  '../src/coordinator-ws.js'
);

type SpawnResults = Awaited<ReturnType<typeof handleSpawnAgent>>;

describe('beacon reverse-channel client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    resetCoordinatorWsClient();
  });

  function startClient(url = 'https://coord.test:3456'): FakeWebSocket {
    startCoordinatorWsClient(url);
    const ws = FakeWebSocket.instances.at(-1);
    if (!ws) {
      throw new Error('client did not construct a WebSocket');
    }
    return ws;
  }

  function respond(ws: FakeWebSocket, payload: unknown) {
    ws.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  /** Resolve when the client writes its response payload to the socket. */
  function nextResponse(ws: FakeWebSocket): Promise<string> {
    const original = ws.send.bind(ws);
    return new Promise(resolve => {
      ws.send = (data: string, cb?: (err?: Error) => void) => {
        original(data, cb);
        resolve(data);
      };
    });
  }

  it('dispatches spawn commands to the handler and replies with its status', async () => {
    const ws = startClient();
    (handleSpawnAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 202,
      body: { spawnId: 's-1', status: 'spawning' },
    } as SpawnResults);

    const responsePromise = nextResponse(ws);
    respond(ws, {
      type: 'command',
      id: 'r1',
      command: 'spawn',
      payload: { personaId: 'p1' },
    });

    const response = JSON.parse(await responsePromise) as {
      type: string;
      id: string;
      ok: boolean;
      status: number;
      body: unknown;
    };
    expect(response).toEqual({
      type: 'response',
      id: 'r1',
      ok: true,
      status: 202,
      body: { spawnId: 's-1', status: 'spawning' },
    });
    expect(handleSpawnAgent).toHaveBeenCalledWith({ personaId: 'p1' });
  });

  it('replies ok:false with the handler status for app-level errors', async () => {
    const ws = startClient();
    (handleSpawnAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 404,
      body: { error: 'persona not found' },
    } as SpawnResults);

    const responsePromise = nextResponse(ws);
    respond(ws, { type: 'command', id: 'r2', command: 'spawn', payload: {} });

    const response = JSON.parse(await responsePromise) as {
      ok: boolean;
      status: number;
    };
    expect(response.ok).toBe(false);
    expect(response.status).toBe(404);
  });

  it('replies ok:false status 500 when the handler throws', async () => {
    const ws = startClient();
    (handleSpawnAgent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom')
    );

    const responsePromise = nextResponse(ws);
    respond(ws, { type: 'command', id: 'r3', command: 'spawn', payload: {} });

    const response = JSON.parse(await responsePromise) as {
      ok: boolean;
      status: number;
      body: { error?: string };
    };
    expect(response.ok).toBe(false);
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('boom');
  });

  it('answers 400 for unknown commands', async () => {
    const ws = startClient();

    const responsePromise = nextResponse(ws);
    respond(ws, { type: 'command', id: 'r4', command: 'doesNotExist' });

    const response = JSON.parse(await responsePromise) as {
      ok: boolean;
      status: number;
      body: { error?: string };
    };
    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Unknown command');
  });
});