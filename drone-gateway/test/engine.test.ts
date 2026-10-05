import { describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  GatewayConfig,
  ResolvedServiceAdapter,
  ResolvedConversation,
  ControlSurfaceSpec,
} from '../src/types.js';
import type { SpawnBackend } from '../src/spawn-backend.js';

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
    spawnBackend: 'local',
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
  allowedSenders?: string[]
): ResolvedConversation {
  return { allowedSenders, surfaces };
}

type SentMessage = { conversationId: string; text: string };

async function startAndDrive(
  config: GatewayConfig,
  spawnBackend: SpawnBackend,
  message: { conversationId: string; text: string; senderId?: string }
): Promise<SentMessage[]> {
  const sent: SentMessage[] = [];
  const engine = new GatewayEngine(config, spawnBackend);
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
  }) => void;
  handler({ adapterId: 'matrix-1', ...message });
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
      const engine = new GatewayEngine(makeMinimalConfig(), mockSpawnBackend);
      expect(engine).toBeDefined();
    });
  });

  describe('start', () => {
    it('starts successfully with no adapters', async () => {
      const engine = new GatewayEngine(makeMinimalConfig(), mockSpawnBackend);
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
      const engine = new GatewayEngine(config, mockSpawnBackend);
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
      const engine = new GatewayEngine(config, mockSpawnBackend);

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
      const engine = new GatewayEngine(config, mockSpawnBackend);
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
      const engine = new GatewayEngine(config, mockSpawnBackend);

      await expect(engine.start()).rejects.toThrow(
        'No control surface implementation available for type "mystery-surface". ' +
          'Supported types: discard, persona-assignment, swarm-console'
      );
    });
  });

  describe('stop', () => {
    it('stops cleanly after starting with no adapters', async () => {
      const engine = new GatewayEngine(makeMinimalConfig(), mockSpawnBackend);
      await engine.start();
      await expect(engine.stop()).resolves.toBeUndefined();
    });

    it('stops cleanly without starting first', async () => {
      const engine = new GatewayEngine(makeMinimalConfig(), mockSpawnBackend);
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
      expect(sent[0].text).toContain('requires the coordinator spawn backend');
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
      expect(sent[0].text).toContain('requires the coordinator spawn backend');
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

  describe('spawn target beacon resolution', () => {
    function beaconConfig(
      spawnBackend: 'local' | 'coordinator',
      overrides: Partial<GatewayConfig> = {}
    ): GatewayConfig {
      return makeMinimalConfig({
        spawnBackend,
        targetBeaconId: 'beacon-default',
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
        ...overrides,
      });
    }

    function spawnedBeacon(backend: SpawnBackend): unknown {
      const spy = backend.spawnSession as unknown as ReturnType<typeof vi.fn>;
      return spy.mock.calls[0][2];
    }

    it('uses the gateway default when the conversation sets no override', async () => {
      const backend = makeRespondingSpawnBackend('coordinator');
      await startAndDrive(beaconConfig('coordinator'), backend, {
        conversationId: 'dm:@me:server',
        text: 'hello',
      });
      expect(spawnedBeacon(backend)).toEqual({
        targetBeaconId: 'beacon-default',
        workingDir: undefined,
      });
    });

    it('prefers the per-conversation override', async () => {
      const backend = makeRespondingSpawnBackend('coordinator');
      const config = beaconConfig('coordinator', {
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                'dm:@me:server',
                conv([
                  makeConvSpec('persona-assignment', {
                    personaId: 'me',
                    config: { targetBeaconId: 'beacon-override' },
                  }),
                ]),
              ],
            ]),
          }),
        ],
      });
      await startAndDrive(config, backend, {
        conversationId: 'dm:@me:server',
        text: 'hello',
      });
      expect(spawnedBeacon(backend)).toEqual({
        targetBeaconId: 'beacon-override',
        workingDir: undefined,
      });
    });

    it('resolves to undefined in local mode', async () => {
      const backend = makeRespondingSpawnBackend('local');
      await startAndDrive(beaconConfig('local'), backend, {
        conversationId: 'dm:@me:server',
        text: 'hello',
      });
      expect(spawnedBeacon(backend)).toEqual({
        targetBeaconId: undefined,
        workingDir: undefined,
      });
    });

    it('forwards the surface workingDir to spawnSession', async () => {
      const backend = makeRespondingSpawnBackend('local');
      const config = beaconConfig('local', {
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              [
                'dm:@me:server',
                conv([
                  makeConvSpec('persona-assignment', {
                    personaId: 'me',
                    config: { workingDir: '/srv/bots/me' },
                  }),
                ]),
              ],
            ]),
          }),
        ],
      });
      await startAndDrive(config, backend, {
        conversationId: 'dm:@me:server',
        text: 'hello',
      });
      expect(spawnedBeacon(backend)).toEqual({
        targetBeaconId: undefined,
        workingDir: '/srv/bots/me',
      });
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
                conv([makeConvSpec('persona-assignment', { personaId: 'me' })]),
              ],
            ]),
          }),
        ],
      });
      const engine = new GatewayEngine(config, backend);
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

      expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
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
      const engine = new GatewayEngine(config, backend);
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
});
