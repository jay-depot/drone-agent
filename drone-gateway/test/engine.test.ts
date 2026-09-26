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

function makeRespondingSpawnBackend(): SpawnBackend {
  return {
    type: 'local' as const,
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
});
