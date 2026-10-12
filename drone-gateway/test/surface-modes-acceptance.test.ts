import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type {
  GatewayConfig,
  ResolvedServiceAdapter,
  ResolvedConversation,
  ControlSurfaceSpec,
  AdapterMessage,
} from '../src/types.js';
import type { SpawnBackend } from '../src/spawn-backend.js';
import { SpawnBackendRegistry } from '../src/spawn-backend-registry.js';
import {
  MENTION_INSTRUCTION,
  OBSERVER_INSTRUCTION,
  ROOM_INSTRUCTION,
} from '../src/chat-format.js';

const adapterStores = vi.hoisted(() => ({
  snapshotStore: undefined as unknown,
  outboundLedger: undefined as unknown,
}));

vi.mock('../src/adapters/matrix.js', () => ({
  MatrixServiceAdapter: vi.fn().mockImplementation(function (id: string) {
    return {
      id,
      type: 'matrix',
      start: vi.fn(),
      stop: vi.fn(),
      sendMessage: vi.fn(),
      onMessage: vi.fn(),
      snapshotStore: adapterStores.snapshotStore,
      outboundLedger: adapterStores.outboundLedger,
    };
  }),
}));

const { GatewayEngine } = await import('../src/engine.js');

type SentMessage = { conversationId: string; text: string };

function makeBackend(overrides: Partial<SpawnBackend> = {}): SpawnBackend {
  return {
    type: 'local' as const,
    spawnSession: vi.fn(async (conversationId: string, personaId: string) => ({
      conversationId,
      personaId,
      processId: 'agent-1',
      startedAt: 0,
    })),
    sendMessage: vi.fn(async () => 'hello back'),
    exportContext: vi.fn(),
    importContext: vi.fn(),
    terminateSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeConfig(surfaceConfig: Record<string, unknown>): GatewayConfig {
  const conversations = new Map<string, ResolvedConversation>([
    [
      '!room:server',
      {
        surfaces: [
          {
            type: 'persona-assignment',
            personaId: 'me',
            config: {
              // The idle timer is disabled so the test isolates the
              // catch-up/batcher interaction; the cadence coupling is covered
              // by the session-lifecycle suite.
              lifecycle: { idleTimeoutMs: 0 },
              ...surfaceConfig,
            },
          } satisfies ControlSurfaceSpec,
        ],
      },
    ],
  ]);
  const adapter: ResolvedServiceAdapter = {
    id: 'matrix-1',
    type: 'matrix',
    config: {},
    conversations,
  };
  return {
    coordinatorUrl: 'http://localhost:8080',
    serviceAdapters: [adapter],
  };
}

/** Start an engine, capture the adapter's inbound handler + sent posts. */
async function startEngine(config: GatewayConfig, backend: SpawnBackend) {
  const registry = new SpawnBackendRegistry();
  registry.register(backend.type, backend);
  const engine = new GatewayEngine(config, registry);
  await engine.start();

  const matrix = (await import('../src/adapters/matrix.js'))
    .MatrixServiceAdapter as unknown as ReturnType<typeof vi.fn>;
  const adapter = matrix.mock.results.at(-1)?.value as {
    onMessage: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };

  const sent: SentMessage[] = [];
  adapter.sendMessage.mockImplementation(
    async (conversationId: string, text: string) => {
      sent.push({ conversationId, text });
    }
  );
  const handler = adapter.onMessage.mock.calls[0][0] as (
    m: AdapterMessage
  ) => void;
  return { engine, handler, sent };
}

function makeMessage(
  text: string,
  overrides: Partial<AdapterMessage> = {}
): AdapterMessage {
  return {
    adapterId: 'matrix-1',
    conversationId: '!room:server',
    text,
    senderName: 'Alice',
    senderId: '@alice:x',
    conversationKind: 'room',
    ...overrides,
  };
}

describe('gateway surface-modes acceptance (ADR 250)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    adapterStores.snapshotStore = undefined;
    adapterStores.outboundLedger = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('observer: buffers three messages into one silent catch-up turn', async () => {
    const backend = makeBackend();
    const { handler, sent } = await startEngine(
      makeConfig({ mode: 'observer', catchUp: { intervalMs: 1000 } }),
      backend
    );

    handler(makeMessage('one', { senderName: 'Alice', senderId: '@alice:x' }));
    handler(makeMessage('two', { senderName: 'Bob', senderId: '@bob:x' }));
    handler(
      makeMessage('three', { senderName: 'Carol', senderId: '@carol:x' })
    );

    // The engine's batch debounce (500 ms) coalesces the burst; the observer
    // buffers it. No turn, no spawn, no post yet.
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.sendMessage).not.toHaveBeenCalled();
    expect(backend.spawnSession).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    // The catch-up timer fires at 1000 ms and flushes the buffer as one turn.
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.sendMessage).toHaveBeenCalledTimes(1);
    const call = (backend.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[1]).toBe(
      '[- from: Alice]\none\n[- from: Bob]\ntwo\n[- from: Carol]\nthree'
    );
    expect(call[2]).toEqual({ systemReminder: OBSERVER_INSTRUCTION });
    // The reply is discarded: nothing is posted.
    expect(sent).toHaveLength(0);
  });

  it('passive: buffers, then posts exactly one reply on a mention', async () => {
    const backend = makeBackend();
    const { handler, sent } = await startEngine(
      makeConfig({ mode: 'passive', catchUp: { intervalMs: 100_000 } }),
      backend
    );

    handler(
      makeMessage('first', { senderName: 'Alice', senderId: '@alice:x' })
    );
    handler(makeMessage('second', { senderName: 'Bob', senderId: '@bob:x' }));

    // Batcher flushes the pair into the passive buffer; still no turn.
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.sendMessage).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    // A mention arrives: the batcher flushes it, and the mention triggers an
    // immediate catch-up carrying the backlog.
    handler(
      makeMessage('hey bot', {
        senderName: 'Carol',
        senderId: '@carol:x',
        mentionsBot: true,
      })
    );
    await vi.advanceTimersByTimeAsync(500);

    expect(backend.sendMessage).toHaveBeenCalledTimes(1);
    const call = (backend.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[1]).toBe(
      '[- from: Alice]\nfirst\n[- from: Bob]\nsecond\n[- from: Carol]\nhey bot'
    );
    expect(call[2]).toEqual({ systemReminder: MENTION_INSTRUCTION });
    // Exactly one post, carrying the backend's reply.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      conversationId: '!room:server',
      text: 'hello back',
    });
  });

  it('active: one message is one turn and one post (regression)', async () => {
    const backend = makeBackend();
    const { handler, sent } = await startEngine(
      makeConfig({ mode: 'active' }),
      backend
    );

    handler(makeMessage('hi', { senderName: 'Alice', senderId: '@alice:x' }));
    await vi.advanceTimersByTimeAsync(500);

    expect(backend.sendMessage).toHaveBeenCalledTimes(1);
    const call = (backend.sendMessage as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[1]).toBe('[- from: Alice]\nhi');
    expect(call[2]).toEqual({ systemReminder: ROOM_INSTRUCTION });
    expect(sent).toEqual([
      { conversationId: '!room:server', text: 'hello back' },
    ]);
  });
});
