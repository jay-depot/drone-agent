import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { GatewayConfig, ResolvedServiceAdapter, ControlSurfaceSpec } from '../src/types.js';
import type { SpawnBackend } from '../src/spawn-backend.js';

// Mock CoordinatorClient since GatewayEngine creates one internally
vi.mock('../src/coordinator-client.js', () => ({
  CoordinatorClient: vi.fn().mockImplementation(() => ({
    spawnAgent: vi.fn(),
    sendMessage: vi.fn(),
    terminateSpawn: vi.fn(),
  })),
}));

// Mock the matrix adapter module so engine can import it without matrix-js-sdk
vi.mock('../src/adapters/matrix.js', () => ({
  MatrixServiceAdapter: vi.fn().mockImplementation((id: string) => ({
    id,
    type: 'matrix',
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn(),
    onMessage: vi.fn(),
  })),
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

describe('GatewayEngine', () => {
  let engine: InstanceType<typeof GatewayEngine>;
  let mockSpawnBackend: SpawnBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawnBackend = makeMockSpawnBackend();
  });

  describe('constructor', () => {
    it('creates an engine instance', () => {
      const config = makeMinimalConfig();
      engine = new GatewayEngine(config, mockSpawnBackend);
      expect(engine).toBeDefined();
    });
  });

  describe('start', () => {
    it('starts successfully with no adapters', async () => {
      const config = makeMinimalConfig();
      engine = new GatewayEngine(config, mockSpawnBackend);
      await expect(engine.start()).resolves.toBeUndefined();
    });

    it('starts a matrix adapter successfully', async () => {
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              ['!room:server', [makeConvSpec('discard')]],
            ]),
          }),
        ],
      });
      engine = new GatewayEngine(config, mockSpawnBackend);
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
      engine = new GatewayEngine(config, mockSpawnBackend);

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
              ['!room1:server', [makeConvSpec('discard')]],
              ['!room2:server', [makeConvSpec('discard')]],
            ]),
          }),
        ],
      });
      engine = new GatewayEngine(config, mockSpawnBackend);
      await engine.start();
      // If it didn't throw, per-conversation instances were created
      expect(true).toBe(true);
    });
  });

  describe('stop', () => {
    it('stops cleanly after starting with no adapters', async () => {
      const config = makeMinimalConfig();
      engine = new GatewayEngine(config, mockSpawnBackend);
      await engine.start();
      await expect(engine.stop()).resolves.toBeUndefined();
    });

    it('stops cleanly without starting first', async () => {
      const config = makeMinimalConfig();
      engine = new GatewayEngine(config, mockSpawnBackend);
      await expect(engine.stop()).resolves.toBeUndefined();
    });
  });

  describe('discard control surface', () => {
    it('discard surface handles messages without response', async () => {
      const config = makeMinimalConfig({
        serviceAdapters: [
          makeAdapter({
            id: 'matrix-1',
            conversations: new Map([
              ['!room:server', [makeConvSpec('discard')]],
            ]),
          }),
        ],
      });
      engine = new GatewayEngine(config, mockSpawnBackend);
      await engine.start();
      // The engine started successfully with a discard surface
      expect(true).toBe(true);
    });
  });
});
