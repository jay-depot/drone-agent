import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the config loader so we don't need filesystem access
const mockLoadGatewayConfig = vi.fn();
vi.mock('../src/config/load.js', () => ({
  loadGatewayConfig: mockLoadGatewayConfig,
}));

// Mock process.exit to prevent test runner from exiting
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  // never actually exit
}) as unknown as typeof process.exit);

// Mock the spawn backends so we don't need actual implementations
vi.mock('../src/local-spawn-backend.js', () => ({
  LocalSpawnBackend: vi.fn().mockImplementation(() => ({
    type: 'local',
    spawnSession: vi.fn(),
    sendMessage: vi.fn(),
    terminateSession: vi.fn(),
  })),
}));

vi.mock('../src/coordinator-spawn-backend.js', () => ({
  CoordinatorSpawnBackend: vi.fn().mockImplementation(() => ({
    type: 'coordinator',
    spawnSession: vi.fn(),
    sendMessage: vi.fn(),
    terminateSession: vi.fn(),
  })),
}));

// Mock engine so main() doesn't actually start anything
const mockEngineStart = vi.fn();
const mockEngineStop = vi.fn();
vi.mock('../src/engine.js', () => ({
  GatewayEngine: vi.fn().mockImplementation(() => ({
    start: mockEngineStart,
    stop: mockEngineStop,
  })),
}));

const { parseArgs, loadConfig, createSpawnBackend, main } =
  await import('../src/index.js');

describe('parseArgs', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('returns default config path when no args given', () => {
    process.argv = ['node', 'drone-gateway'];
    const result = parseArgs();
    expect(result.configPath).toContain('.drone-gateway/config.json');
    expect(result.command).toBe('serve');
  });

  it('uses --config value when provided', () => {
    process.argv = [
      'node',
      'drone-gateway',
      '--config',
      '/custom/path/config.json',
    ];
    const result = parseArgs();
    expect(result.configPath).toBe('/custom/path/config.json');
  });

  it('prints help and exits on --help', () => {
    process.argv = ['node', 'drone-gateway', '--help'];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    parseArgs();
    expect(logSpy).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
    logSpy.mockRestore();
  });

  it('prints help and exits on -h', () => {
    process.argv = ['node', 'drone-gateway', '-h'];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    parseArgs();
    expect(logSpy).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
    logSpy.mockRestore();
  });
});

describe('loadConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and parses a valid config via folder loader', async () => {
    mockLoadGatewayConfig.mockResolvedValue({
      coordinatorUrl: 'http://localhost:8080',
      spawnBackend: 'local',
      serviceAdapters: [],
    });

    const config = await loadConfig('/path/to/config.json');
    expect(config.coordinatorUrl).toBe('http://localhost:8080');
    expect(config.serviceAdapters).toEqual([]);
    expect(config.spawnBackend).toBe('local');
  });

  it('applies default spawnBackend when not set', async () => {
    mockLoadGatewayConfig.mockResolvedValue({
      coordinatorUrl: 'http://localhost:8080',
      serviceAdapters: [],
    });

    const config = await loadConfig('/path/to/config.json');
    expect(config.spawnBackend).toBe('local');
  });

  it('preserves spawnBackend when set', async () => {
    mockLoadGatewayConfig.mockResolvedValue({
      coordinatorUrl: 'http://localhost:8080',
      spawnBackend: 'coordinator',
      serviceAdapters: [],
    });

    const config = await loadConfig('/path/to/config.json');
    expect(config.spawnBackend).toBe('coordinator');
  });
});

describe('createSpawnBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns LocalSpawnBackend for local type', () => {
    const config = {
      coordinatorUrl: 'http://localhost:8080',
      spawnBackend: 'local' as const,
      serviceAdapters: [],
    };
    const backend = createSpawnBackend(config);
    expect(backend.type).toBe('local');
  });

  it('returns CoordinatorSpawnBackend for coordinator type', () => {
    const config = {
      coordinatorUrl: 'http://localhost:8080',
      spawnBackend: 'coordinator' as const,
      serviceAdapters: [],
    };
    const backend = createSpawnBackend(config);
    expect(backend.type).toBe('coordinator');
  });

  it('exits with error for unknown type', () => {
    const config = {
      coordinatorUrl: 'http://localhost:8080',
      spawnBackend: 'unknown',
      serviceAdapters: [],
    };
    createSpawnBackend(config);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe('main', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = ['node', 'drone-gateway'];
    mockLoadGatewayConfig.mockResolvedValue({
      coordinatorUrl: 'http://localhost:8080',
      spawnBackend: 'local',
      serviceAdapters: [],
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('exits with error when engine fails to start', async () => {
    mockEngineStart.mockRejectedValue(new Error('engine error'));

    await main();

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockEngineStop).toHaveBeenCalled();
  });
});
