import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { create as createTar } from 'tar';
import {
  commandExistsOnPath,
  computeCacheKey,
  ensureServerInstalled,
  resolveCacheDir,
  verifyIntegrity,
  type InstallerSpec,
} from '../src/plugins/lsp/installer.js';

const TEST_NODE_ENTRY = 'lib/cli.mjs';

/**
 * Build a synthetic npm-style tarball in memory. We stage files in a
 * temp dir under `package/<name>` (mirroring npm's layout), then pack
 * with `tar.create({ gzip, cwd })` and read the bytes back.
 */
async function buildSyntheticTarball(
  files: Record<string, string>
): Promise<Buffer> {
  const stage = await mkdtemp(path.join(tmpdir(), 'drone-lsp-pack-'));
  try {
    const packageDir = path.join(stage, 'package');
    const libDir = path.join(packageDir, 'lib');
    await import('node:fs/promises').then(m =>
      m.mkdir(libDir, { recursive: true })
    );
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(packageDir, name);
      await import('node:fs/promises').then(m =>
        m.mkdir(path.dirname(full), { recursive: true })
      );
      await writeFile(full, content);
    }
    // Use the promise form of `create` to a memory file.
    const target = path.join(stage, 'pkg.tgz');
    await createTar({ gzip: true, file: target, cwd: stage, portable: true }, [
      'package',
    ]);
    return await readFile(target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function sha512Base64(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('base64');
}

function baseSpec(
  integrity: string,
  tarballUrl = 'https://example.test/pkg.tgz'
): InstallerSpec {
  return {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    install: {
      npmPackage: 'typescript-language-server',
      version: '5.3.0',
      tarballUrl,
      integrity,
      nodeEntry: TEST_NODE_ENTRY,
    },
  };
}

async function withTempCache<T>(
  fn: (cacheDir: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-lsp-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withFakeBinary<T>(
  fn: (binaryPath: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-lsp-bin-'));
  const binaryPath = path.join(dir, 'typescript-language-server');
  await writeFile(binaryPath, '#!/bin/sh\necho fake\n');
  await chmod(binaryPath, 0o755);
  try {
    return await fn(binaryPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('lsp-installer — resolveCacheDir', () => {
  it('honors DRONE_AGENT_LSP_CACHE override', () => {
    const dir = resolveCacheDir(
      { DRONE_AGENT_LSP_CACHE: '/tmp/custom' },
      '/home/x',
      'linux'
    );
    expect(dir).toBe(path.resolve('/tmp/custom'));
  });

  it('falls back to XDG_CACHE_HOME on Linux', () => {
    const dir = resolveCacheDir(
      {
        DRONE_AGENT_LSP_CACHE: '',
        XDG_CACHE_HOME: '/xdg/cache',
      },
      '/home/x',
      'linux'
    );
    expect(dir).toBe(path.join('/xdg/cache', 'drone-agent', 'lsp'));
  });

  it('falls back to macOS path when XDG is unset', () => {
    const dir = resolveCacheDir(
      {
        DRONE_AGENT_LSP_CACHE: '',
        XDG_CACHE_HOME: '',
      },
      '/Users/x',
      'darwin'
    );
    expect(dir).toBe(
      path.join('/Users/x', 'Library', 'Caches', 'drone-agent', 'lsp')
    );
  });

  it('falls back to ~/.cache on Linux when no overrides', () => {
    const dir = resolveCacheDir(
      { DRONE_AGENT_LSP_CACHE: '', XDG_CACHE_HOME: '' },
      '/home/x',
      'linux'
    );
    expect(dir).toBe(path.join('/home/x', '.cache', 'drone-agent', 'lsp'));
  });

  it('falls back to LocalAppData on Windows', () => {
    const dir = resolveCacheDir(
      {
        DRONE_AGENT_LSP_CACHE: '',
        XDG_CACHE_HOME: '',
        LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      },
      'C:\\Users\\x',
      'win32'
    );
    expect(dir).toBe(
      path.join('C:\\Users\\x\\AppData\\Local', 'drone-agent', 'lsp')
    );
  });
});

describe('lsp-installer — computeCacheKey', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeCacheKey({
      serverId: 'typescript',
      version: '5.3.0',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '20.0.0',
    });
    const b = computeCacheKey({
      serverId: 'typescript',
      version: '5.3.0',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '20.0.0',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes with platform', () => {
    const a = computeCacheKey({
      serverId: 'typescript',
      version: '5.3.0',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '20.0.0',
    });
    const b = computeCacheKey({
      serverId: 'typescript',
      version: '5.3.0',
      platform: 'darwin',
      arch: 'x64',
      nodeVersion: '20.0.0',
    });
    expect(a).not.toBe(b);
  });

  it('changes with Node version', () => {
    const a = computeCacheKey({
      serverId: 'typescript',
      version: '5.3.0',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '20.0.0',
    });
    const b = computeCacheKey({
      serverId: 'typescript',
      version: '5.3.0',
      platform: 'linux',
      arch: 'x64',
      nodeVersion: '22.0.0',
    });
    expect(a).not.toBe(b);
  });
});

describe('lsp-installer — verifyIntegrity', () => {
  it('accepts a matching sha512 digest', () => {
    const bytes = Buffer.from('hello world');
    const integrity = `sha512-${sha512Base64(bytes)}`;
    return expect(verifyIntegrity(bytes, integrity)).resolves.toBeUndefined();
  });

  it('rejects a tampered tarball', async () => {
    const bytes = Buffer.from('hello world');
    const wrong = `sha512-${sha512Base64(Buffer.from('hello WORLD'))}`;
    await expect(verifyIntegrity(bytes, wrong)).rejects.toThrow(
      /Integrity check failed/
    );
  });

  it('rejects an unsupported algorithm', async () => {
    await expect(
      verifyIntegrity(Buffer.from('x'), 'sha256-AAAA')
    ).rejects.toThrow(/Unsupported integrity algorithm/);
  });

  it('rejects a malformed integrity string', async () => {
    await expect(
      verifyIntegrity(Buffer.from('x'), 'justgarbage')
    ).rejects.toThrow(/Invalid integrity string/);
  });
});

describe('lsp-installer — commandExistsOnPath', () => {
  it('returns true for the running node binary', async () => {
    // process.execPath is guaranteed to be a real executable on every
    // platform.
    expect(await commandExistsOnPath(process.execPath)).toBe(true);
  });

  it('returns false for an absolute path that does not exist', async () => {
    expect(await commandExistsOnPath('/definitely/not/a/real/binary-xyz')).toBe(
      false
    );
  });

  it('returns false for an empty command', async () => {
    expect(await commandExistsOnPath('')).toBe(false);
  });
});

describe('lsp-installer — ensureServerInstalled', () => {
  it('short-circuits when the command is on PATH', async () => {
    await withFakeBinary(async binaryPath => {
      await withTempCache(async cacheDir => {
        const previous = process.env.PATH;
        process.env.PATH = `${path.dirname(binaryPath)}${path.delimiter}${previous ?? ''}`;
        try {
          const fetchMock = vi.fn(async () => {
            throw new Error('fetch should not be called');
          });
          const resolution = await ensureServerInstalled(
            {
              ...baseSpec('sha512-irrelevant'),
              command: path.basename(binaryPath),
            },
            {
              cacheDir,
              nodePath: '/path/to/node',
              fetchImpl: fetchMock as unknown as typeof fetch,
            }
          );
          expect(resolution.source).toBe('path');
          expect(resolution.command).toBe(path.basename(binaryPath));
          expect(resolution.args).toEqual(['--stdio']);
          expect(fetchMock).not.toHaveBeenCalled();
        } finally {
          process.env.PATH = previous;
        }
      });
    });
  });

  it('downloads, verifies, and extracts on cache miss', async () => {
    const tarball = await buildSyntheticTarball({
      [TEST_NODE_ENTRY]: 'export const main = () => {};',
      'package.json': '{"name":"typescript-language-server"}',
    });
    const integrity = `sha512-${sha512Base64(tarball)}`;
    const spec = baseSpec(integrity);

    await withTempCache(async cacheDir => {
      const fetchMock = vi.fn(async () => {
        return new Response(new Blob([new Uint8Array(tarball)]), {
          status: 200,
        });
      });
      const resolution = await ensureServerInstalled(spec, {
        cacheDir,
        nodePath: '/path/to/node',
        fetchImpl: fetchMock as unknown as typeof fetch,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(spec.install.tarballUrl);
      expect(resolution.source).toBe('cache');
      expect(resolution.command).toBe('/path/to/node');
      // The first arg must point inside the cache, at the entry file
      // for the configured `nodeEntry`.
      expect(resolution.args[0]).toMatch(/lib[/\\]cli\.mjs$/);
      expect(path.dirname(resolution.args[0]!)).toContain(spec.install.version);
      expect(resolution.args.slice(1)).toEqual(['--stdio']);
      expect(resolution.cacheDir).toBeDefined();

      // The entry file should exist on disk after extraction.
      const entryAbs = resolution.args[0]!;
      const content = await readFile(entryAbs, 'utf8');
      expect(content).toContain('main');

      // The install manifest should have been written alongside it.
      const manifestPath = path.join(
        resolution.cacheDir!,
        '.drone-agent-install.json'
      );
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      expect(manifest.serverId).toBe('typescript');
      expect(manifest.version).toBe('5.3.0');
      expect(manifest.npmPackage).toBe('typescript-language-server');
      expect(manifest.installId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('skips the network on a cache hit', async () => {
    const tarball = await buildSyntheticTarball({
      [TEST_NODE_ENTRY]: 'export const main = () => {};',
    });
    const integrity = `sha512-${sha512Base64(tarball)}`;
    const spec = baseSpec(integrity);

    await withTempCache(async cacheDir => {
      // First call populates the cache.
      await ensureServerInstalled(spec, {
        cacheDir,
        nodePath: '/path/to/node',
        fetchImpl: (async () =>
          new Response(new Blob([new Uint8Array(tarball)]), {
            status: 200,
          })) as unknown as typeof fetch,
      });

      // Second call must not invoke fetch.
      const fetchMock = vi.fn(async () => {
        throw new Error('fetch should not be called on cache hit');
      });
      const resolution = await ensureServerInstalled(spec, {
        cacheDir,
        nodePath: '/path/to/node',
        fetchImpl: fetchMock as unknown as typeof fetch,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(resolution.source).toBe('cache');
    });
  });

  it('refuses to extract a tarball whose integrity does not match', async () => {
    const tarball = await buildSyntheticTarball({
      [TEST_NODE_ENTRY]: 'export const main = () => {};',
    });
    // Compute integrity from a *different* buffer.
    const wrongIntegrity = `sha512-${sha512Base64(Buffer.from('not the tarball'))}`;

    await withTempCache(async cacheDir => {
      await expect(
        ensureServerInstalled(baseSpec(wrongIntegrity), {
          cacheDir,
          nodePath: '/path/to/node',
          fetchImpl: (async () =>
            new Response(new Blob([new Uint8Array(tarball)]), {
              status: 200,
            })) as unknown as typeof fetch,
        })
      ).rejects.toThrow(/Integrity check failed/);
    });
  });

  it('surfaces HTTP errors from the download', async () => {
    await withTempCache(async cacheDir => {
      await expect(
        ensureServerInstalled(baseSpec('sha512-anything'), {
          cacheDir,
          nodePath: '/path/to/node',
          fetchImpl: (async () =>
            new Response('boom', {
              status: 500,
              statusText: 'Internal Server Error',
            })) as unknown as typeof fetch,
        })
      ).rejects.toThrow(/LSP server download failed: 500/);
    });
  });

  it('clears a stale cache entry before re-installing', async () => {
    const tarball = await buildSyntheticTarball({
      [TEST_NODE_ENTRY]: 'export const main = () => {};',
    });
    const integrity = `sha512-${sha512Base64(tarball)}`;
    const spec = baseSpec(integrity);

    await withTempCache(async cacheDir => {
      const first = await ensureServerInstalled(spec, {
        cacheDir,
        nodePath: '/path/to/node',
        fetchImpl: (async () =>
          new Response(new Blob([new Uint8Array(tarball)]), {
            status: 200,
          })) as unknown as typeof fetch,
      });

      // Plant garbage in the entry to simulate corruption.
      const entry = first.args[0]!;
      await writeFile(entry, 'corrupted');

      // Make the cache entry invalid so the installer must re-download.
      await rm(path.dirname(entry), { recursive: true, force: true });

      const second = await ensureServerInstalled(spec, {
        cacheDir,
        nodePath: '/path/to/node',
        fetchImpl: (async () =>
          new Response(new Blob([new Uint8Array(tarball)]), {
            status: 200,
          })) as unknown as typeof fetch,
      });

      // The second call should have re-extracted, restoring the original
      // entry contents.
      const content = await readFile(second.args[0]!, 'utf8');
      expect(content).toContain('main');
    });
  });
});
