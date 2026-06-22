import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  constants as fsConstants,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract as extractTar } from 'tar';
import type { DroneLogger } from 'drone-core';

const CACHE_DIR_ENV = 'DRONE_AGENT_LSP_CACHE';
const CACHE_SUBDIR = 'lsp';

/**
 * A description of how a server should be invoked after the installer runs.
 * Mirrors the shape the LSP plugin uses for spawn-style server configs but
 * is kept here as a dedicated type so the installer can be tested in
 * isolation.
 */
export type InstallerResolution = {
  command: string;
  args: string[];
  source: 'path' | 'cache';
  cacheDir?: string;
};

export type InstallerSpec = {
  id: string;
  command: string;
  args: string[];
  install: {
    npmPackage: string;
    version: string;
    tarballUrl: string;
    integrity: string;
    nodeEntry: string;
  };
};

export type InstallerOptions = {
  logger?: DroneLogger;
  /**
   * Override the cache directory. Defaults to an XDG-aware path resolved
   * by `resolveCacheDir()`. Tests pin a tmp directory here.
   */
  cacheDir?: string;
  /**
   * Override `fetch` so tests can inject synthetic tarballs without
   * touching the network.
   */
  fetchImpl?: typeof fetch;
  /**
   * Node executable used to invoke downloaded servers. Defaults to
   * `process.execPath` so the running interpreter runs the cached
   * script. Tests pass a sentinel.
   */
  nodePath?: string;
  /**
   * Override platform/arch in the cache key — useful when the agent is
   * pre-seeding caches on one machine and consuming them on another.
   */
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
};

/**
 * Resolves the per-user cache root. Honors `DRONE_AGENT_LSP_CACHE` if set,
 * then falls back to XDG / macOS / Windows conventions.
 */
export function resolveCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
  platform: NodeJS.Platform = process.platform
): string {
  const override = env[CACHE_DIR_ENV];
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }

  if (platform === 'win32') {
    const localAppData =
      env.LOCALAPPDATA ?? path.join(homedir, 'AppData', 'Local');
    return path.join(localAppData, 'drone-agent', CACHE_SUBDIR);
  }

  const xdgCache = env.XDG_CACHE_HOME;
  if (xdgCache && xdgCache.trim().length > 0) {
    return path.join(xdgCache, 'drone-agent', CACHE_SUBDIR);
  }

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Caches', 'drone-agent', CACHE_SUBDIR);
  }

  return path.join(homedir, '.cache', 'drone-agent', CACHE_SUBDIR);
}

/**
 * Deterministic, platform-stable cache key for a (serverId, version)
 * pair. Includes platform/arch/node so a tarball extracted under one
 * environment is never reused against mismatched native bindings.
 */
export function computeCacheKey(input: {
  serverId: string;
  version: string;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
}): string {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const nodeVersion = input.nodeVersion ?? process.versions.node;
  const material = [
    input.serverId,
    input.version,
    platform,
    arch,
    nodeVersion,
  ].join('|');
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Returns true when `command` resolves to an executable file on PATH.
 * Respects absolute/relative paths and (on Windows) `PATHEXT`. We avoid
 * shelling out so the result is deterministic in tests.
 */
export async function commandExistsOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!command) {
    return false;
  }
  if (command.includes(path.sep) || command.includes('/')) {
    try {
      await access(command, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathEnv = env.PATH ?? '';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map(ext => ext.toLowerCase())
      : [''];
  const directories = pathEnv.split(pathSep).filter(Boolean);
  for (const directory of directories) {
    for (const ext of exts) {
      const candidate = path.join(directory, command + ext);
      try {
        await access(candidate, fsConstants.X_OK);
        return true;
      } catch {
        // continue
      }
    }
  }
  return false;
}

/**
 * Verifies a downloaded tarball against the pinned `dist.integrity`
 * value from npm. Supports sha512 (the only algorithm npm publishes).
 * Throws if the digest does not match or the format is unrecognized.
 */
export async function verifyIntegrity(
  tarballBytes: Buffer,
  integrity: string
): Promise<void> {
  const dashIndex = integrity.indexOf('-');
  if (dashIndex === -1) {
    throw new Error(
      `Invalid integrity string: "${integrity}" (expected "algo-base64digest").`
    );
  }
  const algorithm = integrity.slice(0, dashIndex);
  const expected = integrity.slice(dashIndex + 1);
  if (!algorithm || !expected) {
    throw new Error(
      `Invalid integrity string: "${integrity}" (expected "algo-base64digest").`
    );
  }
  if (algorithm !== 'sha512') {
    throw new Error(
      `Unsupported integrity algorithm "${algorithm}" (only sha512 is supported).`
    );
  }
  const actual = createHash('sha512').update(tarballBytes).digest('base64');
  // Constant-time compare to avoid timing leaks even though integrity
  // values are public metadata.
  if (!timingSafeEqualStrings(actual, expected)) {
    throw new Error(
      `Integrity check failed for downloaded LSP server.\n` +
        `  expected: ${integrity}\n` +
        `  actual:   sha512-${actual}\n` +
        `If the published tarball has been republished, update the ` +
        `pinned integrity in the LSP plugin manifest. The actual ` +
        `digest is shown above for that purpose.`
    );
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

async function withCacheLock<T>(
  lockPath: string,
  fn: () => Promise<T>
): Promise<T> {
  // Atomic create-if-missing. If we race and lose, retry briefly until
  // the winner releases the lock. File locks are advisory on POSIX; the
  // worst-case outcome is two parallel downloads, which the integrity
  // check still makes safe.
  const fsPromises = await import('node:fs/promises');
  await fsPromises.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const handle = await fsPromises.open(lockPath, 'wx');
      try {
        return await fn();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Could not acquire LSP installer lock: ${lockPath}`);
}

async function downloadTarball(
  url: string,
  fetchImpl: typeof fetch
): Promise<Buffer> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `LSP server download failed: ${response.status} ${response.statusText} (${url})`
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function extractTarball(
  tarball: Buffer,
  destination: string
): Promise<void> {
  await mkdir(destination, { recursive: true });
  // `tar.extract` accepts a stream: pipe the buffer in and let tar detect
  // gzip via magic bytes. `strip: 1` removes the leading `package/`
  // directory npm tarballs always wrap their contents in.
  await pipeline(
    Readable.from(tarball),
    extractTar({
      cwd: destination,
      strip: 1,
    })
  );
}

async function isCacheEntryValid(
  cacheDir: string,
  nodeEntry: string
): Promise<boolean> {
  const entry = path.join(cacheDir, nodeEntry);
  try {
    await access(entry, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotently ensures a server is installed and runnable. Returns the
 * command + args to spawn, plus provenance (`path` vs. `cache`).
 *
 * Flow:
 *  1. If the configured command is on PATH, return it unchanged.
 *  2. Otherwise, look for a valid cache entry; if found, return it.
 *  3. Otherwise, download the pinned tarball, verify its sha512 integrity,
 *     extract into the cache under a lock, and return the resolved entry.
 *  4. Any failure along the way is thrown — callers translate it into the
 *     runtime's `status: "error"` state.
 */
export async function ensureServerInstalled(
  spec: InstallerSpec,
  options: InstallerOptions = {}
): Promise<InstallerResolution> {
  const logger = options.logger;
  const cacheRoot = options.cacheDir ?? resolveCacheDir();
  const cacheKey = computeCacheKey({
    serverId: spec.id,
    version: spec.install.version,
    platform: options.platform,
    arch: options.arch,
    nodeVersion: options.nodeVersion,
  });
  const cacheDir = path.join(
    cacheRoot,
    spec.id,
    spec.install.version,
    cacheKey
  );
  const resolvedNode = options.nodePath ?? process.execPath;

  // 1. PATH probe — short-circuit before any disk activity.
  if (await commandExistsOnPath(spec.command)) {
    return { command: spec.command, args: spec.args, source: 'path' };
  }

  // 2. Cache hit — verify the entrypoint exists and return.
  if (await isCacheEntryValid(cacheDir, spec.install.nodeEntry)) {
    logger?.info?.(
      `lsp server cached: ${spec.id}@${spec.install.version} (${cacheDir})`
    );
    return {
      command: resolvedNode,
      args: [path.join(cacheDir, spec.install.nodeEntry), ...spec.args],
      source: 'cache',
      cacheDir,
    };
  }

  // 3. Cache miss — install under a lock to avoid duplicate downloads.
  logger?.info?.(
    `lsp server not found on PATH; downloading ${spec.install.npmPackage}@${spec.install.version}…`
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  await withCacheLock(path.join(cacheRoot, spec.id, '.lock'), async () => {
    // Re-check after acquiring the lock — another process may have
    // finished populating the cache while we waited.
    if (await isCacheEntryValid(cacheDir, spec.install.nodeEntry)) {
      return;
    }
    // Always start from a clean slate so a partial extraction can't
    // poison a subsequent attempt.
    await rm(cacheDir, { recursive: true, force: true });
    await mkdir(cacheDir, { recursive: true });

    const tarball = await downloadTarball(spec.install.tarballUrl, fetchImpl);
    await verifyIntegrity(tarball, spec.install.integrity);
    await extractTarball(tarball, cacheDir);

    // Persist a manifest so users can audit where a cached copy came
    // from.
    await writeFile(
      path.join(cacheDir, '.drone-agent-install.json'),
      JSON.stringify(
        {
          serverId: spec.id,
          npmPackage: spec.install.npmPackage,
          version: spec.install.version,
          installedAt: new Date().toISOString(),
          installId: randomUUID(),
          tarballUrl: spec.install.tarballUrl,
          integrity: spec.install.integrity,
          nodeVersion: process.versions.node,
        },
        null,
        2
      ),
      'utf8'
    );

    // Defensive: make the cached entry readable. Node doesn't need the
    // executable bit since we invoke it directly via `node`, but setting
    // 0o644 makes the cache directory self-debugging.
    try {
      const entryAbs = path.join(cacheDir, spec.install.nodeEntry);
      await chmod(entryAbs, 0o644);
    } catch {
      // Non-fatal.
    }
  });

  // 4. Final verification — refuse to return a resolution we can't use.
  if (!(await isCacheEntryValid(cacheDir, spec.install.nodeEntry))) {
    throw new Error(
      `LSP server entry not found after install: ${path.join(cacheDir, spec.install.nodeEntry)}`
    );
  }

  return {
    command: resolvedNode,
    args: [path.join(cacheDir, spec.install.nodeEntry), ...spec.args],
    source: 'cache',
    cacheDir,
  };
}

/**
 * Removes cache directories whose version is no longer referenced by any
 * known spec. Safe to call at startup. Only deletes well-formed entries
 * (matches `<cacheRoot>/<serverId>/<version>/<key>/`) — never anything the
 * user might have put under the cache root.
 */
export async function pruneStaleEntries(
  specs: InstallerSpec[],
  options: { cacheDir?: string } = {}
): Promise<void> {
  const cacheRoot = options.cacheDir ?? resolveCacheDir();
  const keep = new Set<string>();
  for (const spec of specs) {
    keep.add(path.join(cacheRoot, spec.id, spec.install.version));
  }

  let serverDirs: string[];
  try {
    serverDirs = await readdir(cacheRoot);
  } catch {
    return;
  }

  for (const serverDir of serverDirs) {
    const serverPath = path.join(cacheRoot, serverDir);
    const serverStat = await stat(serverPath).catch(() => null);
    if (!serverStat?.isDirectory()) {
      continue;
    }
    const versions = await readdir(serverPath).catch(() => []);
    for (const version of versions) {
      if (version === '.lock' || version.startsWith('.')) {
        continue;
      }
      const versionPath = path.join(serverPath, version);
      const versionStat = await stat(versionPath).catch(() => null);
      if (!versionStat?.isDirectory()) {
        continue;
      }
      if (!keep.has(versionPath)) {
        await rm(versionPath, { recursive: true, force: true });
      }
    }
  }
}