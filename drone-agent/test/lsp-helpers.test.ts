import { describe, expect, it, vi, beforeEach } from 'vitest';
import path from 'node:path';

const readdirMock = vi.fn();

vi.mock('node:fs/promises', () => ({
  readdir: (...args: unknown[]) => readdirMock(...args),
  access: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  opendir: vi.fn(),
}));

import { collectWorkspaceFiles } from '../src/plugins/lsp/server/helpers.js';

function dirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
  };
}

describe('collectWorkspaceFiles', () => {
  beforeEach(() => {
    readdirMock.mockReset();
  });

  it('skips unreadable directories instead of throwing EACCES', async () => {
    const root = '/home/test';
    readdirMock.mockImplementation((dir: string) => {
      if (dir === root) {
        return Promise.resolve([
          dirent('readable', true),
          dirent('blocked', true),
          dirent('file.ts', false),
        ]);
      }
      if (dir === path.join(root, 'readable')) {
        return Promise.resolve([dirent('nested.ts', false)]);
      }
      // The unreadable directory (e.g. ~/.dropbox-dist) throws EACCES.
      const error: NodeJS.ErrnoException = new Error('permission denied');
      error.code = 'EACCES';
      return Promise.reject(error);
    });

    const matches = await collectWorkspaceFiles(root, ['.ts']);

    expect(matches).toEqual([
      path.join(root, 'file.ts'),
      path.join(root, 'readable', 'nested.ts'),
    ]);
  });

  it('still collects files when everything is readable', async () => {
    const root = '/home/test';
    readdirMock.mockImplementation((dir: string) => {
      if (dir === root) {
        return Promise.resolve([dirent('a.ts', false), dirent('b.py', false)]);
      }
      return Promise.resolve([]);
    });

    const matches = await collectWorkspaceFiles(root, ['.ts']);

    expect(matches).toEqual([path.join(root, 'a.ts')]);
  });
});
