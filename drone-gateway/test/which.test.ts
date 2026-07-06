import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock node:fs/promises at module level so which.ts gets the mock
const mockAccess = vi.fn();
vi.mock('node:fs/promises', () => ({
  access: mockAccess,
}));

// Import after vi.mock so the mock is applied
const { which } = await import('../src/which.js');

describe('which', () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    process.env.PATH = '/usr/bin:/usr/local/bin';
    mockAccess.mockReset();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('returns full path when binary exists in PATH', async () => {
    // Make the first directory fail, second succeed
    mockAccess
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValueOnce(undefined);

    const result = await which('drone-agent');
    expect(result).toBe('/usr/local/bin/drone-agent');
  });

  it('returns full path from first matching directory', async () => {
    mockAccess.mockResolvedValueOnce(undefined);

    const result = await which('node');
    expect(result).toBe('/usr/bin/node');
  });

  it('throws when binary is not found in any PATH directory', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    await expect(which('nonexistent-binary')).rejects.toThrow(
      'Binary not found in PATH: nonexistent-binary'
    );
  });

  it('handles empty PATH gracefully', async () => {
    process.env.PATH = '';
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    await expect(which('anything')).rejects.toThrow(
      'Binary not found in PATH: anything'
    );
  });

  it('handles PATH with only empty entries', async () => {
    process.env.PATH = ':::';
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    await expect(which('anything')).rejects.toThrow(
      'Binary not found in PATH: anything'
    );
  });
});
