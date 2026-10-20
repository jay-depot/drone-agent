import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const redeemMock = vi.fn();
vi.mock('drone-swarm-common', async importActual => {
  const actual = await importActual<typeof import('drone-swarm-common')>();
  return { ...actual, redeemPreApprovalToken: redeemMock };
});

const startMock = vi.fn();
vi.mock('../src/mcp-server.js', () => ({
  createInvoker: vi.fn(),
}));
vi.mock('../src/http-server.js', () => ({
  startMcpHttpServer: startMock,
}));

const { parsePreApprovalTokenPath, resolveConfig, main } =
  await import('../src/index.js');

const originalArgv = process.argv;
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {
  /* never exit */
}) as unknown as typeof process.exit);

beforeEach(() => {
  redeemMock.mockReset();
  startMock.mockReset();
  mockExit.mockClear();
});

afterEach(() => {
  process.argv = originalArgv;
});

describe('parsePreApprovalTokenPath', () => {
  it('parses the =value form', () => {
    expect(
      parsePreApprovalTokenPath(['--pre-approval-token-path=./token.json'])
    ).toBe('./token.json');
  });

  it('parses the space-separated form', () => {
    expect(
      parsePreApprovalTokenPath(['--pre-approval-token-path', './token.json'])
    ).toBe('./token.json');
  });

  it('returns undefined when absent', () => {
    expect(parsePreApprovalTokenPath([])).toBeUndefined();
  });

  it('accepts both forms with the same path', () => {
    const a = parsePreApprovalTokenPath([
      '--pre-approval-token-path',
      '/tmp/t.json',
    ]);
    const b = parsePreApprovalTokenPath([
      '--pre-approval-token-path=/tmp/t.json',
    ]);
    expect(a).toBe(b);
  });
});

describe('resolveConfig', () => {
  it('omits preApprovalTokenPath by default', () => {
    process.argv = ['node', 'mcp-swarm'];
    const cfg = resolveConfig({} as NodeJS.ProcessEnv);
    expect(cfg.preApprovalTokenPath).toBeUndefined();
  });

  it('picks up the flag from argv', () => {
    process.argv = ['node', 'mcp-swarm', '--pre-approval-token-path=./t.json'];
    const cfg = resolveConfig({} as NodeJS.ProcessEnv);
    expect(cfg.preApprovalTokenPath).toBe('./t.json');
  });
});

describe('main pre-approval path', () => {
  it('redeems and exits without starting the daemon', async () => {
    process.argv = [
      'node',
      'mcp-swarm',
      '--pre-approval-token-path',
      './token.json',
    ];
    redeemMock.mockResolvedValue(undefined);
    await main();
    expect(redeemMock).toHaveBeenCalledWith(
      expect.objectContaining({ tokenPath: './token.json' })
    );
    expect(startMock).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('exits 1 when redemption fails', async () => {
    process.argv = [
      'node',
      'mcp-swarm',
      '--pre-approval-token-path=./token.json',
    ];
    redeemMock.mockRejectedValue(new Error('nope'));
    await main();
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(startMock).not.toHaveBeenCalled();
  });
});
