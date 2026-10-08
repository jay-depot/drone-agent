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
  LocalSpawnBackend: vi.fn().mockImplementation(function () {
    return {
      type: 'local',
      spawnSession: vi.fn(),
      sendMessage: vi.fn(),
      terminateSession: vi.fn(),
    };
  }),
}));

vi.mock('../src/coordinator-spawn-backend.js', () => ({
  CoordinatorSpawnBackend: vi.fn().mockImplementation(function () {
    return {
      type: 'coordinator',
      spawnSession: vi.fn(),
      sendMessage: vi.fn(),
      terminateSession: vi.fn(),
    };
  }),
}));

// Mock engine so main() doesn't actually start anything
const mockEngineStart = vi.fn();
const mockEngineStop = vi.fn();
vi.mock('../src/engine.js', () => ({
  GatewayEngine: vi.fn().mockImplementation(function () {
    return {
      start: mockEngineStart,
      stop: mockEngineStop,
    };
  }),
}));

const mockControlApiStart = vi.fn();
const mockControlApiStop = vi.fn();
vi.mock('../src/control-api/server.js', () => ({
  ControlApiServer: vi.fn().mockImplementation(function () {
    return {
      start: mockControlApiStart,
      stop: mockControlApiStop,
    };
  }),
}));

const { parseArgs, loadConfig, createSpawnBackends, main } =
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
      serviceAdapters: [],
    });

    const config = await loadConfig('/path/to/config.json');
    expect(config.coordinatorUrl).toBe('http://localhost:8080');
    expect(config.serviceAdapters).toEqual([]);
  });
});

describe('createSpawnBackends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers only the local backend when no coordinator client is given', () => {
    const config = {
      coordinatorUrl: '',
      serviceAdapters: [],
    };
    const registry = createSpawnBackends(config);
    expect(registry.types()).toEqual(['local']);
  });

  it('registers both backends when a coordinator client is given', () => {
    const config = {
      coordinatorUrl: 'http://localhost:8080',
      serviceAdapters: [],
    };
    const client = { spawnAgent: vi.fn() } as never;
    const registry = createSpawnBackends(config, client);
    expect(registry.types()).toEqual(['coordinator', 'local']);
  });
});

describe('main', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = ['node', 'drone-gateway'];
    mockLoadGatewayConfig.mockResolvedValue({
      coordinatorUrl: 'http://localhost:8080',
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

  it('starts the control API when controlApi is enabled', async () => {
    mockEngineStart.mockResolvedValue(undefined);
    mockLoadGatewayConfig.mockResolvedValue({
      coordinatorUrl: 'http://localhost:8080',
      serviceAdapters: [],
      controlApi: { enabled: true, host: '127.0.0.1', port: 8090 },
    });

    // main() never resolves (it awaits a never-settling promise); assert the
    // server was started without awaiting completion.
    void main();
    await vi.waitFor(() => expect(mockControlApiStart).toHaveBeenCalled());
  });
});
