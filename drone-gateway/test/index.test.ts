import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const callOrder: string[] = [];

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
      exportContext: vi.fn(),
      importContext: vi.fn(),
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
      exportContext: vi.fn(),
      importContext: vi.fn(),
      terminateSession: vi.fn(),
    };
  }),
}));

const mockNodeStart = vi.fn(() => {
  callOrder.push('node.start');
});
const mockNodeStop = vi.fn(async () => {
  callOrder.push('node.stop');
});
vi.mock('../src/extension-node.js', () => ({
  ExtensionNodeHandle: vi.fn().mockImplementation(function () {
    return {
      start: mockNodeStart,
      stop: mockNodeStop,
      isReady: vi.fn(() => true),
      fetch: vi.fn(async () => new Response('ok')),
    };
  }),
}));

// Mock engine so main() doesn't actually start anything
const mockEngineStart = vi.fn();
const mockEngineStop = vi.fn(async () => {
  callOrder.push('engine.stop');
});
vi.mock('../src/engine.js', () => ({
  GatewayEngine: vi.fn().mockImplementation(function () {
    return {
      start: mockEngineStart,
      stop: mockEngineStop,
    };
  }),
}));

const mockControlApiStart = vi.fn();
const mockControlApiStop = vi.fn(async () => {
  callOrder.push('controlApi.stop');
});
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
    callOrder.length = 0;
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

  it('does not create an extension node without a coordinator', async () => {
    mockEngineStart.mockResolvedValue(undefined);
    mockLoadGatewayConfig.mockResolvedValue({
      coordinatorUrl: '',
      serviceAdapters: [],
    });

    void main();
    await vi.waitFor(() => expect(mockEngineStart).toHaveBeenCalled());
    await new Promise(resolve => setImmediate(resolve));

    expect(mockNodeStart).not.toHaveBeenCalled();
  });

  it('starts the extension node without awaiting it', async () => {
    mockEngineStart.mockResolvedValue(undefined);
    mockLoadGatewayConfig.mockResolvedValue({
      coordinatorUrl: 'http://127.0.0.1:3456',
      swarmExtension: {
        id: 'drone-gateway',
        name: 'Drone Gateway',
        dataDir: '/tmp/ext',
        requestTimeoutMs: 15000,
      },
      serviceAdapters: [],
    });

    void main();

    await vi.waitFor(() => expect(mockNodeStart).toHaveBeenCalled());
  });

  it('shuts down control API, then engine, then the extension node', async () => {
    mockEngineStart.mockResolvedValue(undefined);
    mockLoadGatewayConfig.mockResolvedValue({
      coordinatorUrl: 'http://127.0.0.1:3456',
      swarmExtension: {
        id: 'drone-gateway',
        name: 'Drone Gateway',
        dataDir: '/tmp/ext',
        requestTimeoutMs: 15000,
      },
      serviceAdapters: [],
      controlApi: { enabled: true, host: '127.0.0.1', port: 8090 },
    });

    const handlers = new Map<string, () => Promise<void>>();
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: () => Promise<void>
    ) => {
      handlers.set(event, handler);
      return process;
    }) as never);

    void main();
    await vi.waitFor(() => expect(mockControlApiStart).toHaveBeenCalled());

    const shutdown = handlers.get('SIGTERM');
    expect(shutdown).toBeDefined();
    await shutdown!();

    expect(callOrder).toEqual([
      'node.start',
      'controlApi.stop',
      'engine.stop',
      'node.stop',
    ]);
    expect(mockExit).toHaveBeenCalledWith(0);
    onSpy.mockRestore();
  });
});
