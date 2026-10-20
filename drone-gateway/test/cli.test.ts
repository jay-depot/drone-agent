import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const redeemMock = vi.fn();
vi.mock('drone-swarm-common', async importActual => {
  const actual = await importActual<typeof import('drone-swarm-common')>();
  return { ...actual, redeemPreApprovalToken: redeemMock };
});

const loadConfigMock = vi.fn();
vi.mock('../src/config/load.js', () => ({
  loadGatewayConfig: loadConfigMock,
}));

vi.mock('../src/engine.js', () => ({
  GatewayEngine: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn() };
  }),
}));
vi.mock('../src/local-spawn-backend.js', () => ({
  LocalSpawnBackend: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock('../src/coordinator-spawn-backend.js', () => ({
  CoordinatorSpawnBackend: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock('../src/extension-node.js', () => ({
  ExtensionNodeHandle: vi.fn().mockImplementation(function () {
    return { start: vi.fn(), stop: vi.fn(async () => {}), fetch: vi.fn() };
  }),
}));

const { parseArgs, main } = await import('../src/index.js');

const originalArgv = process.argv;
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  /* never exit */
}) as unknown as typeof process.exit);

beforeEach(() => {
  redeemMock.mockReset();
  loadConfigMock.mockReset();
  mockExit.mockClear();
});

afterEach(() => {
  process.argv = originalArgv;
});

describe('gateway parseArgs --pre-approval-token-path', () => {
  it('parses the =value form', () => {
    process.argv = [
      'node',
      'drone-gateway',
      '--pre-approval-token-path=./token.json',
    ];
    expect(parseArgs().preApprovalTokenPath).toBe('./token.json');
  });

  it('parses the space-separated form', () => {
    process.argv = [
      'node',
      'drone-gateway',
      '--pre-approval-token-path',
      './token.json',
    ];
    expect(parseArgs().preApprovalTokenPath).toBe('./token.json');
  });

  it('is absent by default', () => {
    process.argv = ['node', 'drone-gateway'];
    expect(parseArgs().preApprovalTokenPath).toBeUndefined();
  });
});

describe('gateway main pre-approval path', () => {
  it('redeems and exits without starting the daemon', async () => {
    process.argv = [
      'node',
      'drone-gateway',
      '--pre-approval-token-path=./token.json',
    ];
    loadConfigMock.mockResolvedValue({
      coordinatorUrl: 'https://10.0.0.5:3456',
      swarmExtension: {
        id: 'gw-1',
        name: 'Gateway',
        dataDir: '/tmp/gw',
        requestTimeoutMs: 1000,
      },
      serviceAdapters: [],
    });
    redeemMock.mockResolvedValue(undefined);
    await main();
    expect(redeemMock).toHaveBeenCalledWith({
      coordinatorUrl: 'https://10.0.0.5:3456',
      dataDir: '/tmp/gw',
      id: 'gw-1',
      name: 'Gateway',
      tokenPath: './token.json',
    });
  });

  it('exits 1 when redemption fails', async () => {
    process.argv = [
      'node',
      'drone-gateway',
      '--pre-approval-token-path',
      './token.json',
    ];
    loadConfigMock.mockResolvedValue({
      coordinatorUrl: 'https://10.0.0.5:3456',
      swarmExtension: {
        id: 'gw-1',
        name: 'Gateway',
        dataDir: '/tmp/gw',
        requestTimeoutMs: 1000,
      },
      serviceAdapters: [],
    });
    redeemMock.mockRejectedValue(new Error('nope'));
    await main();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits 1 when there is no swarm extension config', async () => {
    process.argv = [
      'node',
      'drone-gateway',
      '--pre-approval-token-path=./token.json',
    ];
    loadConfigMock.mockResolvedValue({
      coordinatorUrl: 'https://10.0.0.5:3456',
      serviceAdapters: [],
    });
    await main();
    expect(redeemMock).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
