import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock fetch for logout
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock fs for adapter config reading
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}));

// Mock fs/promises for rm
const mockRm = vi.fn();
vi.mock('node:fs/promises', () => ({
  rm: mockRm,
}));

const { cleanupAdapter } = await import('../src/cleanup.js');

describe('cleanupAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        type: 'matrix',
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
        dataPath: '/tmp/matrix-store',
      })
    );
    mockFetch.mockResolvedValue({ ok: true });
    mockRm.mockResolvedValue(undefined);
  });

  it('reads adapter config and confirms before proceeding', async () => {
    const confirmFn = vi.fn().mockResolvedValue(true);

    await cleanupAdapter('/tmp/.drone-gateway', 'matrix-main', confirmFn);

    // Should have read the adapter config
    expect(mockReadFileSync).toHaveBeenCalledWith(
      '/tmp/.drone-gateway/adapters/matrix-main/adapter.json',
      'utf-8'
    );

    // Should have called logout
    expect(mockFetch).toHaveBeenCalledWith(
      'https://matrix.org/_matrix/client/v3/logout',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer syt_token',
        }),
      })
    );

    // Should have deleted dataPath
    expect(mockRm).toHaveBeenCalledWith('/tmp/matrix-store', {
      recursive: true,
      force: true,
    });
  });

  it('exits with error if adapter not found', async () => {
    mockExistsSync.mockReturnValue(false);
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as unknown as typeof process.exit);
    const confirmFn = vi.fn().mockResolvedValue(true);

    await cleanupAdapter('/tmp/.drone-gateway', 'nonexistent', confirmFn);

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('exits with error if adapter type is not matrix', async () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        type: 'telegram',
      })
    );
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as unknown as typeof process.exit);
    const confirmFn = vi.fn().mockResolvedValue(true);

    await cleanupAdapter('/tmp/.drone-gateway', 'telegram-1', confirmFn);

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('cancels cleanup if user does not confirm', async () => {
    const confirmFn = vi.fn().mockResolvedValue(false);
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as unknown as typeof process.exit);

    await cleanupAdapter('/tmp/.drone-gateway', 'matrix-main', confirmFn);

    // Should NOT have called logout or rm
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRm).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(0);
    mockExit.mockRestore();
  });

  it('handles logout failure gracefully', async () => {
    const confirmFn = vi.fn().mockResolvedValue(true);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('unauthorized'),
    });

    await cleanupAdapter('/tmp/.drone-gateway', 'matrix-main', confirmFn);

    // Should still proceed to delete dataPath even if logout fails
    expect(mockRm).toHaveBeenCalledWith('/tmp/matrix-store', {
      recursive: true,
      force: true,
    });
  });

  it('handles missing dataPath gracefully', async () => {
    const confirmFn = vi.fn().mockResolvedValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        type: 'matrix',
        homeserverUrl: 'https://matrix.org',
        accessToken: 'syt_token',
        userId: '@bot:matrix.org',
        // no dataPath
      })
    );

    // Should not throw
    await cleanupAdapter('/tmp/.drone-gateway', 'matrix-main', confirmFn);

    // Should still attempt logout
    expect(mockFetch).toHaveBeenCalled();
    // Should not attempt to delete dataPath
    expect(mockRm).not.toHaveBeenCalled();
  });
});
