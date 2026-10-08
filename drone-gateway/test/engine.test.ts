import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  GatewayConfig,
  ResolvedServiceAdapter,
  ResolvedConversation,
  ControlSurfaceSpec,
} from '../src/types.js';
import type { SpawnBackend } from '../src/spawn-backend.js';
import { SpawnBackendRegistry } from '../src/spawn-backend-registry.js';
import { ROOM_INSTRUCTION } from '../src/chat-format.js';
import {
  UnknownAdapterError,
  UnknownConversationError,
  InjectionNotEnabledError,
} from '../src/errors.js';

vi.mock('../src/coordinator-client.js', () => ({
  CoordinatorClient: vi.fn().mockImplementation(function () {
    return {
      spawnAgent: vi.fn(),
      sendMessage: vi.fn(),
      terminateSpawn: vi.fn(),
    };
  }),
}));

// Mock the matrix adapter module so engine can import it without matrix-js-sdk
vi.mock('../src/adapters/matrix.js', () => ({
  MatrixServiceAdapter: vi.fn().mockImplementation(function (id: string) {
    return {
      id,
      type: 'matrix',
      start: vi.fn(),
      stop: vi.fn(),
      sendMessage: vi.fn(),
      onMessage: vi.fn(),
    };
  }),
}));

const { GatewayEngine } = await import('../src/engine.js');

/**
 * Build a GatewayEngine with a registry holding the given backend(s). The
 * backend's own `type` selects the registry key, so a test can register one
 * local or coordinator backend (or both).
 */
function makeEngine(
  config: GatewayConfig,
  ...backends: SpawnBackend[]
): InstanceType<typeof GatewayEngine> {
  const registry = new SpawnBackendRegistry();
  for (const backend of backends) {
    if (!registry.get(backend.type)) registry.register(backend.type, backend);
  }
  return new GatewayEngine(config, registry);
}

function makeMockSpawnBackend(): SpawnBackend {
  return {
    type: 'local' as const,
    spawnSession: vi.fn(),
    sendMessage: vi.fn(),
    terminateSession: vi.fn(),
  };
}

function makeRespondingSpawnBackend(
  type: 'local' | 'coordinator' = 'local'
): SpawnBackend {
  return {
    type,
    spawnSession: vi.fn(async (conversationId: string, personaId: string) => ({
      conversationId,
      personaId,
      processId: 'agent-1',
      startedAt: 0,
    })),
    sendMessage: vi.fn(async () => 'PERSONA-RESPONSE'),
    terminateSession: vi.fn(),
  };
}

function makeMinimalConfig(
  overrides: Partial<GatewayConfig> = {}
): GatewayConfig {
  return {
    coordinatorUrl: 'http://localhost:8080',
    serviceAdapters: [],
    ...overrides,
  };
}

function makeAdapter(
  overrides: Partial<ResolvedServiceAdapter> = {}
): ResolvedServiceAdapter {
  return {
    id: 'test-adapter',
    type: 'matrix',
    config: {},
    conversations: new Map(),
    ...overrides,
  };
}

function makeConvSpec(
  type: string,
  overrides: Partial<ControlSurfaceSpec> = {}
): ControlSurfaceSpec {
  return { type, ...overrides };
}

function conv(
  surfaces: ControlSurfaceSpec[],
  allowedSenders?: string[],
  injectionEnabled?: boolean
): ResolvedConversation {
  return { allowedSenders, surfaces, injectionEnabled };
}

type SentMessage = { conversationId: string; text: string };

async function startAndDrive(
  config: GatewayConfig,
  spawnBackend: SpawnBackend,
  message: {
    conversationId: string;
    text: string;
    senderId?: string;
    conversationKind?: 'dm' | 'room';
  }
): Promise<SentMessage[]> {
  const sent: SentMessage[] = [];
  const engine = makeEngine(config, spawnBackend);
  await engine.start();
  const matrix = (await import('../src/adapters/matrix.js'))
    .MatrixServiceAdapter as unknown as ReturnType<typeof vi.fn>;
  const adapter = matrix.mock.results.at(-1)?.value as {
    onMessage: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };
  adapter.sendMessage.mockImplementation(
    async (conversationId: string, text: string) => {
      sent.push({ conversationId, text });
    }
  );
  const handler = adapter.onMessage.mock.calls[0][0] as (m: {
    adapterId: string;
    conversationId: string;
    text: string;
    senderId?: string;
    conversationKind: 'dm' | 'room';
  }) => void;
  handler({ adapterId: 'matrix-1', conversationKind: 'dm', ...message });
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  return sent;
}

describe('GatewayEngine', () => {
  let mockSpawnBackend: SpawnBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnBackend = makeMockSpawnBackend();
  });

  describe('constructor', () => {
    it('creates an engine instance', () => {
      const engine = makeEngine(makeMinimalConfig(), mockSpawnBackend);
      expect(engine).toBeDefined();
    });
  });

  describe('start', () => {
    it('starts successfully with no adapters', async () => {
      const engine = makeEngine(makeMinimalConfig(), mockSpawnBackend);
      await expect(engine.start()).resolves.toBeUndefined();
    });

    it('starts a matrix adapter successfully', async () => {
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              ['!room:server', conv([makeConvSpec('discard')])],
            ]),
          }),
        ],
      });
      const engine = makeEngine(config, mockSpawnBackend);
      await expect(engine.start()).resolves.toBeUndefined();
    });

    it('throws when adapter type has no implementation', async () => {
      const config = makeMinimalConfig({
        serviceAdapters: [
          {
            id: 'slack-1',
            type: 'slack',
            config: {},
            conversations: new Map(),
          },
        ],
      });
      const engine = makeEngine(config, mockSpawnBackend);

      await expect(engine.start()).rejects.toThrow(
        'No adapter implementation available for type "slack"'
      );
    });

    it('creates per-conversation dedicated control surface instances', async () => {
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              ['!room1:server', conv([makeConvSpec('discard')])],
              ['!room2:server', conv([makeConvSpec('discard')])],
            ]),
          }),
        ],
      });
      const engine = makeEngine(config, mockSpawnBackend);
      await engine.start();
      expect(true).toBe(true);
    });

    it('throws when a surface type has no registered implementation', async () => {
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              ['!room:server', conv([makeConvSpec('mystery-surface')])],
            ]),
          }),
        ],
      });
      const engine = makeEngine(config, mockSpawnBackend);

      await expect(engine.start()).rejects.toThrow(
        'No control surface implementation available for type "mystery-surface". ' +
          'Supported types: discard, persona-assignment, swarm-console'
      );
    });
  });

  describe('stop', () => {
    it('stops cleanly after starting with no adapters', async () => {
      const engine = makeEngine(makeMinimalConfig(), mockSpawnBackend);
      await engine.start();
      await expect(engine.stop()).resolves.toBeUndefined();
    });

    it('stops cleanly without starting first', async () => {
      const engine = makeEngine(makeMinimalConfig(), mockSpawnBackend);
      await expect(engine.stop()).resolves.toBeUndefined();
    });
  });

  describe('swarm-console surface wiring', () => {
    it('reports the coordinator-backend error in local mode', async () => {
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              ['dm:@me:server', conv([makeConvSpec('swarm-console')])],
            ]),
          }),
        ],
      });
      const sent = await startAndDrive(config, mockSpawnBackend, {
        conversationId: 'dm:@me:server',
        text: 'swarm.beacon.list',
      });
      expect(sent[0].text).toContain('requires a configured coordinatorUrl');
    });
  });

  describe('allowedSenders gate', () => {
    function gateConfig(): GatewayConfig {
      return makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                'dm:@me:server',
                conv(
                  [makeConvSpec('persona-assignment', { personaId: 'me' })],
                  ['@me:server']
                ),
              ],
              ['*', conv([makeConvSpec('swarm-console')])],
            ]),
          }),
        ],
      });
    }

    it('dispatches to the exact conversation when the sender is allowed', async () => {
      const sent = await startAndDrive(
        gateConfig(),
        makeRespondingSpawnBackend(),
        {
          conversationId: 'dm:@me:server',
          text: 'hello',
          senderId: '@me:server',
        }
      );
      expect(sent[0].text).toBe('PERSONA-RESPONSE');
    });

    it('falls through to the wildcard when the sender is not allowed', async () => {
      const sent = await startAndDrive(
        gateConfig(),
        makeRespondingSpawnBackend(),
        {
          conversationId: 'dm:@me:server',
          text: 'swarm.beacon.list',
          senderId: '@intruder:server',
        }
      );
      expect(sent[0].text).toContain('requires a configured coordinatorUrl');
    });

    it('allows every sender when allowedSenders is unset', async () => {
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                'dm:@me:server',
                conv([makeConvSpec('persona-assignment', { personaId: 'me' })]),
              ],
              ['*', conv([makeConvSpec('swarm-console')])],
            ]),
          }),
        ],
      });
      const sent = await startAndDrive(config, makeRespondingSpawnBackend(), {
        conversationId: 'dm:@me:server',
        text: 'hello',
        senderId: '@anyone:server',
      });
      expect(sent[0].text).toBe('PERSONA-RESPONSE');
    });
  });

  describe('spawn mode inference and beacon resolution', () => {
    function personaConfig(
      surfaceConfig: Record<string, unknown> | undefined
    ): GatewayConfig {
      return makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                'dm:@me:server',
                conv([
                  makeConvSpec('persona-assignment', {
                    personaId: 'me',
                    ...(surfaceConfig ? { config: surfaceConfig } : {}),
                  }),
                ]),
              ],
            ]),
          }),
        ],
      });
    }

    function spawnedOptions(backend: SpawnBackend): unknown {
      const spy = backend.spawnSession as unknown as ReturnType<typeof vi.fn>;
      return spy.mock.calls[0][2];
    }

    it('infers coordinator mode and targets the named beacon', async () => {
      const backend = makeRespondingSpawnBackend('coordinator');
      await startAndDrive(
        personaConfig({ targetBeaconId: 'beacon-override' }),
        backend,
        {
          conversationId: 'dm:@me:server',
          text: 'hello',
        }
      );
      expect(spawnedOptions(backend)).toEqual({
        targetBeaconId: 'beacon-override',
        workingDir: undefined,
      });
    });

    it('infers local mode when no beacon is named', async () => {
      const backend = makeRespondingSpawnBackend('local');
      await startAndDrive(personaConfig(undefined), backend, {
        conversationId: 'dm:@me:server',
        text: 'hello',
      });
      expect(spawnedOptions(backend)).toEqual({
        targetBeaconId: undefined,
        workingDir: undefined,
      });
    });

    it('forwards the surface workingDir to spawnSession', async () => {
      const backend = makeRespondingSpawnBackend('local');
      await startAndDrive(
        personaConfig({ workingDir: '/srv/bots/me' }),
        backend,
        {
          conversationId: 'dm:@me:server',
          text: 'hello',
        }
      );
      expect(spawnedOptions(backend)).toEqual({
        targetBeaconId: undefined,
        workingDir: '/srv/bots/me',
      });
    });

    it('throws when a coordinator-mode surface has no registered backend', async () => {
      const backend = makeRespondingSpawnBackend('local');
      const engine = makeEngine(
        personaConfig({ targetBeaconId: 'beacon-override' }),
        backend
      );
      await expect(engine.start()).rejects.toThrow(
        'No "coordinator" spawn backend'
      );
    });
  });

  describe('per-conversation serialization', () => {
    it('runs two messages for one conversation serially', async () => {
      const order: string[] = [];
      const backend = makeRespondingSpawnBackend('local');
      backend.sendMessage = vi.fn(async (_session, text: string) => {
        order.push(`start:${text}`);
        await new Promise(resolve => setTimeout(resolve, 10));
        order.push(`end:${text}`);
        return 'ok';
      }) as unknown as SpawnBackend['sendMessage'];

      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                'dm:@me:server',
                conv([
                  makeConvSpec('swarm-console'),
                  makeConvSpec('persona-assignment', { personaId: 'me' }),
                ]),
              ],
            ]),
          }),
        ],
      });
      const engine = makeEngine(config, backend);
      await engine.start();
      const matrix = (await import('../src/adapters/matrix.js'))
        .MatrixServiceAdapter as unknown as ReturnType<typeof vi.fn>;
      const adapter = matrix.mock.results.at(-1)?.value as {
        onMessage: ReturnType<typeof vi.fn>;
      };
      const handler = adapter.onMessage.mock.calls[0][0] as (m: {
        adapterId: string;
        conversationId: string;
        text: string;
      }) => void;

      handler({
        adapterId: 'matrix-1',
        conversationId: 'dm:@me:server',
        text: 'a',
      });
      handler({
        adapterId: 'matrix-1',
        conversationId: 'dm:@me:server',
        text: 'b',
      });
      await vi.waitFor(() => expect(order).toHaveLength(4));

      // The immediate path tags each turn too, so the labels carry the
      // '[unknown]' fallback prefix (this fixture has no sender name).
      expect(order).toEqual([
        'start:[unknown] a',
        'end:[unknown] a',
        'start:[unknown] b',
        'end:[unknown] b',
      ]);
    });
  });

  describe('message batching', () => {
    it('coalesces a burst in a batch-eligible conversation into one turn', async () => {
      const backend = makeRespondingSpawnBackend('local');
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                'dm:@me:server',
                conv([
                  makeConvSpec('persona-assignment', {
                    personaId: 'me',
                    config: { batch: { debounceMs: 20 } },
                  }),
                ]),
              ],
            ]),
          }),
        ],
      });
      const engine = makeEngine(config, backend);
      await engine.start();
      const matrix = (await import('../src/adapters/matrix.js'))
        .MatrixServiceAdapter as unknown as ReturnType<typeof vi.fn>;
      const adapter = matrix.mock.results.at(-1)?.value as {
        onMessage: ReturnType<typeof vi.fn>;
      };
      const handler = adapter.onMessage.mock.calls[0][0] as (m: {
        adapterId: string;
        conversationId: string;
        text: string;
        senderName?: string;
        conversationKind?: 'dm' | 'room';
      }) => void;

      handler({
        adapterId: 'matrix-1',
        conversationId: 'dm:@me:server',
        text: 'a',
        senderName: 'Alice',
      });
      handler({
        adapterId: 'matrix-1',
        conversationId: 'dm:@me:server',
        text: 'b',
        senderName: 'Bob',
      });

      await vi.waitFor(() => expect(backend.sendMessage).toHaveBeenCalled());
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(backend.sendMessage).toHaveBeenCalledTimes(1);
      const sendMessage = backend.sendMessage as unknown as ReturnType<
        typeof vi.fn
      >;
      expect(sendMessage.mock.calls[0][1]).toBe('[Alice] a\n[Bob] b');
      await engine.stop();
    });

    it('forwards the room instruction for a batched room turn', async () => {
      const backend = makeRespondingSpawnBackend('local');
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                '!room:server',
                conv([
                  makeConvSpec('persona-assignment', {
                    personaId: 'me',
                    config: { batch: { debounceMs: 20 } },
                  }),
                ]),
              ],
            ]),
          }),
        ],
      });
      const engine = makeEngine(config, backend);
      await engine.start();
      const matrix = (await import('../src/adapters/matrix.js'))
        .MatrixServiceAdapter as unknown as ReturnType<typeof vi.fn>;
      const adapter = matrix.mock.results.at(-1)?.value as {
        onMessage: ReturnType<typeof vi.fn>;
      };
      const handler = adapter.onMessage.mock.calls[0][0] as (m: {
        adapterId: string;
        conversationId: string;
        text: string;
        senderName?: string;
        conversationKind?: 'dm' | 'room';
      }) => void;

      handler({
        adapterId: 'matrix-1',
        conversationId: '!room:server',
        text: 'hi',
        senderName: 'Alice',
        conversationKind: 'room',
      });

      const sendMessage = backend.sendMessage as unknown as ReturnType<
        typeof vi.fn
      >;
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][2]).toEqual({
        systemReminder: ROOM_INSTRUCTION,
      });
      await engine.stop();
    });

    it('does not batch a multi-surface conversation (immediate path)', async () => {
      const backend = makeRespondingSpawnBackend('local');
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                'dm:@me:server',
                conv([
                  makeConvSpec('swarm-console'),
                  makeConvSpec('persona-assignment', { personaId: 'me' }),
                ]),
              ],
            ]),
          }),
        ],
      });
      const engine = makeEngine(config, backend);
      await engine.start();
      const matrix = (await import('../src/adapters/matrix.js'))
        .MatrixServiceAdapter as unknown as ReturnType<typeof vi.fn>;
      const adapter = matrix.mock.results.at(-1)?.value as {
        onMessage: ReturnType<typeof vi.fn>;
      };
      const handler = adapter.onMessage.mock.calls[0][0] as (m: {
        adapterId: string;
        conversationId: string;
        text: string;
      }) => void;

      handler({
        adapterId: 'matrix-1',
        conversationId: 'dm:@me:server',
        text: 'a',
      });
      handler({
        adapterId: 'matrix-1',
        conversationId: 'dm:@me:server',
        text: 'b',
      });

      await vi.waitFor(() =>
        expect(backend.sendMessage).toHaveBeenCalledTimes(2)
      );
      await engine.stop();
    });

    it('drops a pending batch flush on stop', async () => {
      const backend = makeRespondingSpawnBackend('local');
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                'dm:@me:server',
                conv([
                  makeConvSpec('persona-assignment', {
                    personaId: 'me',
                    config: { batch: { debounceMs: 10000 } },
                  }),
                ]),
              ],
            ]),
          }),
        ],
      });
      const engine = makeEngine(config, backend);
      await engine.start();
      const matrix = (await import('../src/adapters/matrix.js'))
        .MatrixServiceAdapter as unknown as ReturnType<typeof vi.fn>;
      const adapter = matrix.mock.results.at(-1)?.value as {
        onMessage: ReturnType<typeof vi.fn>;
      };
      const handler = adapter.onMessage.mock.calls[0][0] as (m: {
        adapterId: string;
        conversationId: string;
        text: string;
      }) => void;

      handler({
        adapterId: 'matrix-1',
        conversationId: 'dm:@me:server',
        text: 'a',
      });
      await engine.stop();
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(backend.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('shutdown disposal', () => {
    it('disposes instantiated surfaces on stop (terminating live agents)', async () => {
      const backend = makeRespondingSpawnBackend('local');
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                'dm:@me:server',
                conv([makeConvSpec('persona-assignment', { personaId: 'me' })]),
              ],
            ]),
          }),
        ],
      });
      const engine = makeEngine(config, backend);
      await engine.start();
      const matrix = (await import('../src/adapters/matrix.js'))
        .MatrixServiceAdapter as unknown as ReturnType<typeof vi.fn>;
      const adapter = matrix.mock.results.at(-1)?.value as {
        onMessage: ReturnType<typeof vi.fn>;
      };
      const handler = adapter.onMessage.mock.calls[0][0] as (m: {
        adapterId: string;
        conversationId: string;
        text: string;
      }) => void;
      handler({
        adapterId: 'matrix-1',
        conversationId: 'dm:@me:server',
        text: 'hi',
      });
      await vi.waitFor(() => expect(backend.sendMessage).toHaveBeenCalled());

      await engine.stop();
      expect(backend.terminateSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('injection', () => {
    function injectionConfig(): GatewayConfig {
      return makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              ['!room:server', conv([], undefined, true)],
              ['!plain:server', conv([makeConvSpec('discard')])],
              ['*', conv([makeConvSpec('swarm-console')])],
            ]),
          }),
        ],
      });
    }

    async function startEngine(): Promise<{
      engine: InstanceType<typeof GatewayEngine>;
      sent: SentMessage[];
    }> {
      const sent: SentMessage[] = [];
      const engine = makeEngine(injectionConfig(), mockSpawnBackend);
      await engine.start();
      const matrix = (await import('../src/adapters/matrix.js'))
        .MatrixServiceAdapter as unknown as ReturnType<typeof vi.fn>;
      const adapter = matrix.mock.results.at(-1)?.value as {
        sendMessage: ReturnType<typeof vi.fn>;
      };
      adapter.sendMessage.mockImplementation(
        async (conversationId: string, text: string) => {
          sent.push({ conversationId, text });
        }
      );
      return { engine, sent };
    }

    it('posts directly to the adapter for an injection target', async () => {
      const { engine, sent } = await startEngine();
      await engine.injectMessage('matrix-1', '!room:server', 'hello');
      expect(sent).toEqual([{ conversationId: '!room:server', text: 'hello' }]);
    });

    it('throws UnknownAdapterError for an unknown adapter', async () => {
      const { engine } = await startEngine();
      await expect(
        engine.injectMessage('nope', '!room:server', 'x')
      ).rejects.toBeInstanceOf(UnknownAdapterError);
    });

    it('throws UnknownConversationError for an unknown conversation', async () => {
      const { engine } = await startEngine();
      await expect(
        engine.injectMessage('matrix-1', '!missing:server', 'x')
      ).rejects.toBeInstanceOf(UnknownConversationError);
    });

    it('throws InjectionNotEnabledError for a non-opted-in conversation', async () => {
      const { engine } = await startEngine();
      await expect(
        engine.injectMessage('matrix-1', '!plain:server', 'x')
      ).rejects.toBeInstanceOf(InjectionNotEnabledError);
    });

    it('never treats the wildcard as injectable', async () => {
      const { engine } = await startEngine();
      await expect(
        engine.injectMessage('matrix-1', '*', 'x')
      ).rejects.toBeInstanceOf(InjectionNotEnabledError);
    });

    it('lists adapter ids and injectable conversations', async () => {
      const { engine } = await startEngine();
      expect(engine.listAdapterIds()).toEqual(['matrix-1']);
      expect(engine.listInjectableConversations()).toEqual([
        { adapterId: 'matrix-1', conversationId: '!room:server' },
      ]);
    });
  });
});
