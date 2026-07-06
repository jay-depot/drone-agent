import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { GatewayConfig } from '../src/types.js';
import type { SpawnBackend } from '../src/spawn-backend.js';

// Mock CoordinatorClient since GatewayEngine creates one internally
vi.mock('../src/coordinator-client.js', () => ({
  CoordinatorClient: vi.fn().mockImplementation(() => ({
    spawnAgent: vi.fn(),
    sendMessage: vi.fn(),
    terminateSpawn: vi.fn(),
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

    it('throws when adapter type has no implementation', async () => {
      const config = makeMinimalConfig({
        serviceAdapters: [
          {
            id: 'matrix-1',
            type: 'matrix',
            config: {},
            controlSurfaces: [],
          },
        ],
      });
      engine = new GatewayEngine(config, mockSpawnBackend);

      await expect(engine.start()).rejects.toThrow(
        'No adapter implementation available for type "matrix"'
      );
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
});
