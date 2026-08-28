import { createHash, randomUUID } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { execFile } from 'node:child_process';
import { commandExistsOnPath } from 'drone-core';
import type {
  DroneLspInstallSpec,
  DroneLspPlatformKey,
  DroneLogger,
} from 'drone-core';
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
import { promisify } from 'node:util';
import { extract as extractTar } from 'tar';

const execFileAsync = promisify(execFile);

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
  install: DroneLspInstallSpec;
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
 * Extract a single gzip-compressed file (not a tar archive). Used for
 * GitHub release assets like rust-analyzer which are distributed as
 * `.gz` files containing a single binary.
 *
 * The decompressed file is written to `destination/<entryPoint>`.
 */
async function extractGzipSingle(
  compressed: Buffer,
  destination: string,
  entryPoint: string
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const decompressed = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    createGunzip()
      .on('error', reject)
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .end(compressed);
  });
  if (decompressed.length === 0) {
    throw new Error('Decompressed gzip file is empty');
  }
  const targetPath = path.join(destination, entryPoint);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, decompressed);
  await chmod(targetPath, 0o755);
}

/**
 * Resolve the download URL for a tarball based on the install type.
 * For `github-release`, the URL is pre-resolved in the spec (includes
 * platform/arch). For other types, we construct the URL from the
 * package name and version.
 */
export function resolveTarballUrl(spec: DroneLspInstallSpec): string {
  switch (spec.type) {
    case 'npm':
    case 'github-release':
      return spec.tarballUrl;
    case 'cargo':
      return `https://crates.io/api/v1/crates/${spec.package}/${spec.version}/download`;
    case 'pip':
      // PyPI source tarball URL pattern:
      // https://pypi.org/packages/source/{first-char}/{package}/{package}-{version}.tar.gz
      return `https://pypi.org/packages/source/${spec.package[0]}/${spec.package}/${spec.package}-${spec.version}.tar.gz`;
    case 'go':
      return `https://proxy.golang.org/${spec.package}/@v/${spec.version}.zip`;
    default:
      return spec.tarballUrl;
  }
}

/**
 * Resolve the platform-specific tarball URL and integrity hash for the
 * current platform. Falls back to the top-level spec fields when no
 * platform override exists.
 */
export function resolvePlatformSpec(spec: DroneLspInstallSpec): {
  tarballUrl: string;
  integrity: string;
} {
  const platformKey =
    `${process.platform}-${process.arch}` as DroneLspPlatformKey;
  const platformOverride = spec.platforms?.[platformKey];
  if (platformOverride) {
    return platformOverride;
  }
  return { tarballUrl: spec.tarballUrl, integrity: spec.integrity };
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
  destination: string,
  strip: number = 1
): Promise<void> {
  await mkdir(destination, { recursive: true });
  await pipeline(
    Readable.from(tarball),
    extractTar({
      cwd: destination,
      strip,
    })
  );
}

/**
 * Minimal ZIP extraction using Node.js built-in `zlib` and `Buffer`.
 * Handles the standard ZIP format (deflate-compressed entries) as used
 * by the Go module proxy. Strips the top-level directory from each
 * entry path.
 *
 * The Go module proxy zip layout is:
 *   <package>@<version>/<files...>
 * We strip the first path component so files land directly in
 * `destination`.
 */
async function extractZip(
  zipBuffer: Buffer,
  destination: string
): Promise<void> {
  await mkdir(destination, { recursive: true });

  // Locate the End of Central Directory record.
  const eocdSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdIndex = zipBuffer.lastIndexOf(eocdSignature);
  if (eocdIndex === -1) {
    throw new Error('Invalid ZIP: no EOCD signature found');
  }

  // Parse EOCD to get the central directory offset.
  // EOCD structure (from eocdIndex):
  //   signature: 4 bytes
  //   diskNumber: 2 bytes
  //   diskWithCD: 2 bytes
  //   numEntriesOnDisk: 2 bytes
  //   totalEntries: 2 bytes
  //   cdSize: 4 bytes
  //   cdOffset: 4 bytes (absolute from start of archive)
  //   commentLength: 2 bytes
  const cdOffset = zipBuffer.readUInt32LE(eocdIndex + 16);
  const numEntries = zipBuffer.readUInt16LE(eocdIndex + 10);

  // Walk the central directory entries.
  let cdPos = cdOffset;
  for (let i = 0; i < numEntries; i += 1) {
    // Central directory file header signature: 0x02014b50
    if (zipBuffer.readUInt32LE(cdPos) !== 0x02014b50) {
      throw new Error(
        `Invalid ZIP: bad central directory entry at offset ${cdPos}`
      );
    }

    const compressionMethod = zipBuffer.readUInt16LE(cdPos + 10);
    const crc32 = zipBuffer.readUInt32LE(cdPos + 16);
    const compressedSize = zipBuffer.readUInt32LE(cdPos + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cdPos + 24);
    const fileNameLength = zipBuffer.readUInt16LE(cdPos + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(cdPos + 30);
    const commentLength = zipBuffer.readUInt16LE(cdPos + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cdPos + 42);

    const fileName = zipBuffer.toString(
      'utf8',
      cdPos + 46,
      cdPos + 46 + fileNameLength
    );

    // Skip directories and __MACOSX artifacts.
    if (fileName.endsWith('/') || fileName.includes('__MACOSX')) {
      cdPos += 46 + fileNameLength + extraFieldLength + commentLength;
      continue;
    }

    // Strip the top-level directory (Go module proxy layout).
    const strippedName = fileName.replace(/^[^/]+\//, '');
    if (!strippedName) {
      cdPos += 46 + fileNameLength + extraFieldLength + commentLength;
      continue;
    }

    // Read the local file header to find the actual data offset.
    // Local file header signature: 0x04034b50
    if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(
        `Invalid ZIP: bad local header at offset ${localHeaderOffset}`
      );
    }
    const localFileNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraFieldLength = zipBuffer.readUInt16LE(
      localHeaderOffset + 28
    );
    const dataOffset =
      localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;

    const compressedData = zipBuffer.subarray(
      dataOffset,
      dataOffset + compressedSize
    );

    let decompressed: Buffer;
    if (compressionMethod === 0) {
      // Stored (no compression).
      decompressed = compressedData;
    } else if (compressionMethod === 8) {
      // Deflate.
      const { inflateRaw } = await import('node:zlib');
      decompressed = await new Promise<Buffer>((resolve, reject) => {
        inflateRaw(compressedData, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
    } else {
      throw new Error(
        `Unsupported ZIP compression method: ${compressionMethod}`
      );
    }

    const targetPath = path.join(destination, strippedName);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, decompressed);
  }
}

async function isCacheEntryValid(
  cacheDir: string,
  entryPoint: string
): Promise<boolean> {
  const entry = path.join(cacheDir, entryPoint);
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
  // Native binaries (github-release, go) are invoked directly; npm packages
  // need `node` to run.
  const isNative =
    spec.install.type === 'github-release' || spec.install.type === 'go';
  const entryPath = path.join(
    cacheDir,
    spec.install.entryPoint ?? spec.command
  );

  // 1. PATH probe — short-circuit before any disk activity.
  if (await commandExistsOnPath(spec.command, process.env)) {
    return { command: spec.command, args: spec.args, source: 'path' };
  }

  // 2. Cache hit — verify the entrypoint exists and return.
  if (
    await isCacheEntryValid(cacheDir, spec.install.entryPoint ?? spec.command)
  ) {
    logger?.info?.(
      `lsp server cached: ${spec.id}@${spec.install.version} (${cacheDir})`
    );
    return {
      command: isNative ? entryPath : resolvedNode,
      args: isNative ? spec.args : [entryPath, ...spec.args],
      source: 'cache',
      cacheDir,
    };
  }

  // 3. Cache miss — install under a lock to avoid duplicate downloads.
  logger?.info?.(
    `lsp server not found on PATH; downloading ${spec.install.package}@${spec.install.version}…`
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  await withCacheLock(path.join(cacheRoot, spec.id, '.lock'), async () => {
    // Re-check after acquiring the lock — another process may have
    // finished populating the cache while we waited.
    if (
      await isCacheEntryValid(cacheDir, spec.install.entryPoint ?? spec.command)
    ) {
      return;
    }
    // Always start from a clean slate so a partial extraction can't
    // poison a subsequent attempt.
    await rm(cacheDir, { recursive: true, force: true });
    await mkdir(cacheDir, { recursive: true });

    const { tarballUrl: resolvedUrl, integrity: resolvedIntegrity } =
      resolvePlatformSpec(spec.install);
    const tarball = await downloadTarball(
      resolveTarballUrl({ ...spec.install, tarballUrl: resolvedUrl }),
      fetchImpl
    );
    await verifyIntegrity(tarball, resolvedIntegrity);

    // Dispatch between tar.gz and zip extraction based on the URL.
    const downloadUrl = resolveTarballUrl({
      ...spec.install,
      tarballUrl: resolvedUrl,
    });
    if (downloadUrl.endsWith('.zip')) {
      await extractZip(tarball, cacheDir);
    } else if (
      downloadUrl.endsWith('.gz') &&
      !downloadUrl.endsWith('.tar.gz') &&
      spec.install.type === 'github-release'
    ) {
      const entryPoint = spec.install.entryPoint ?? spec.command;
      await extractGzipSingle(tarball, cacheDir, entryPoint);
    } else {
      await extractTarball(tarball, cacheDir, spec.install.strip ?? 1);
    }

    // Install npm dependencies for `npm` type installs. npm tarballs only
    // contain the package's own files — dependencies must be resolved at
    // install time so that `require('vscode-languageserver/node')` works.
    if (spec.install.type === 'npm') {
      try {
        await execFileAsync(
          'npm',
          [
            'install',
            '--production',
            '--no-audit',
            '--no-fund',
            '--no-package-lock',
          ],
          {
            cwd: cacheDir,
          }
        );
      } catch (installError) {
        throw new Error(
          `Failed to install npm dependencies for ${spec.install.package}@${spec.install.version}.\n` +
            `  Error: ${(installError as Error).message}\n` +
            `npm must be installed and on PATH to use auto-installed LSP servers.`,
          { cause: installError }
        );
      }
    }

    // Build step for `go` type installs.
    if (spec.install.type === 'go') {
      const entryPoint = spec.install.entryPoint ?? spec.command;
      try {
        await execFileAsync('go', ['build', '-o', entryPoint], {
          cwd: cacheDir,
        });
      } catch (buildError) {
        throw new Error(
          `Failed to build ${spec.install.package} from source. Go must be installed and on PATH.\n` +
            `  Error: ${(buildError as Error).message}\n` +
            `If you don't have Go installed, install gopls manually or set it up via your system package manager.`,
          { cause: buildError }
        );
      }
    }

    // Persist a manifest so users can audit where a cached copy came
    // from.
    await writeFile(
      path.join(cacheDir, '.drone-agent-install.json'),
      JSON.stringify(
        {
          serverId: spec.id,
          packageName: spec.install.package,
          version: spec.install.version,
          installedAt: new Date().toISOString(),
          installId: randomUUID(),
          tarballUrl: resolveTarballUrl({
            ...spec.install,
            tarballUrl: resolvedUrl,
          }),
          integrity: resolvedIntegrity,
          nodeVersion: process.versions.node,
        },
        null,
        2
      ),
      'utf8'
    );

    // Defensive: make the cached entry readable. Node doesn't need the
    // executable bit since we invoke it directly via `node`, but setting
    // 0o644 makes the cache directory self-debugging. Native binaries
    // get 0o755 so they can be executed directly.
    try {
      const entryAbs = path.join(
        cacheDir,
        spec.install.entryPoint ?? spec.command
      );
      await chmod(entryAbs, isNative ? 0o755 : 0o644);
    } catch {
      // Non-fatal.
    }
  });

  // 4. Final verification — refuse to return a resolution we can't use.
  if (
    !(await isCacheEntryValid(
      cacheDir,
      spec.install.entryPoint ?? spec.command
    ))
  ) {
    throw new Error(
      `LSP server entry not found after install: ${path.join(cacheDir, spec.install.entryPoint ?? spec.command)}`
    );
  }

  return {
    command: isNative ? entryPath : resolvedNode,
    args: isNative ? spec.args : [entryPath, ...spec.args],
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
