import {
  access,
  chmod,
  constants as fsConstants,
  mkdir,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { DronePlugin } from 'drone-core';

// ── Constants ──────────────────────────────────────────────────────────────

const PLUGIN_ID = 'lightpanda';
const CACHE_SUBDIR = 'lightpanda';
const NIGHTLY_TAG = 'nightly';
const NIGHTLY_BASE =
  'https://github.com/lightpanda-io/browser/releases/download/nightly';

/**
 * How often (in milliseconds) to re-check the nightly release for updates.
 * Default: 24 hours.
 */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Manifest file written into the cache directory after a successful download.
 * Used to track when the binary was installed and from which URL.
 */
type LightpandaManifest = {
  version: string;
  platform: string;
  arch: string;
  downloadedAt: string;
  downloadUrl: string;
  sha256: string;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveCacheDir(): string {
  const override = process.env.DRONE_AGENT_LIGHTPANDA_CACHE;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }

  const homedir = os.homedir();
  const platform = process.platform;

  if (platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(homedir, 'AppData', 'Local');
    return path.join(localAppData, 'drone-agent', CACHE_SUBDIR);
  }

  const xdgCache = process.env.XDG_CACHE_HOME;
  if (xdgCache && xdgCache.trim().length > 0) {
    return path.join(xdgCache, 'drone-agent', CACHE_SUBDIR);
  }

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Caches', 'drone-agent', CACHE_SUBDIR);
  }

  return path.join(homedir, '.cache', 'drone-agent', CACHE_SUBDIR);
}

function getBinaryName(): string {
  return process.platform === 'win32' ? 'lightpanda.exe' : 'lightpanda';
}

function getDownloadUrl(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'linux' && arch === 'x64') {
    return `${NIGHTLY_BASE}/lightpanda-x86_64-linux`;
  }
  if (platform === 'linux' && arch === 'arm64') {
    return `${NIGHTLY_BASE}/lightpanda-aarch64-linux`;
  }
  if (platform === 'darwin' && arch === 'x64') {
    return `${NIGHTLY_BASE}/lightpanda-x86_64-macos`;
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return `${NIGHTLY_BASE}/lightpanda-aarch64-macos`;
  }

  return null;
}

async function commandExistsOnPath(command: string): Promise<boolean> {
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

  const pathEnv = process.env.PATH ?? '';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
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

async function readManifest(
  cacheDir: string
): Promise<LightpandaManifest | null> {
  try {
    const data = await import('node:fs/promises').then(fs =>
      fs.readFile(path.join(cacheDir, '.drone-agent-install.json'), 'utf8')
    );
    return JSON.parse(data) as LightpandaManifest;
  } catch {
    return null;
  }
}

async function writeManifest(
  cacheDir: string,
  manifest: LightpandaManifest
): Promise<void> {
  await writeFile(
    path.join(cacheDir, '.drone-agent-install.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );
}

function computeSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Check whether the cached binary is stale enough to warrant a re-download.
 * Returns `true` if the manifest is missing, or if enough time has passed
 * since the last download.
 */
function shouldCheckForUpdate(manifest: LightpandaManifest | null): boolean {
  if (!manifest) {
    return true;
  }
  const elapsed = Date.now() - new Date(manifest.downloadedAt).getTime();
  return elapsed >= UPDATE_CHECK_INTERVAL_MS;
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export const lightpandaPlugin: DronePlugin = {
  metadata: {
    id: PLUGIN_ID,
    name: 'Lightpanda',
    version: '0.1.0',
    description:
      'Downloads and manages a local installation of the Lightpanda headless browser, ensuring it is available on PATH for the agent.',
    defaultEnabled: false,
  },
  register: async registration => {
    registration.hooks.onPluginsLoaded(async () => {
      // 1. If already on PATH, nothing to do.
      if (await commandExistsOnPath('lightpanda')) {
        registration.logger.info('lightpanda found on PATH');
        return;
      }

      // 2. Determine the download URL for this platform/arch.
      const downloadUrl = getDownloadUrl();
      if (!downloadUrl) {
        registration.logger.warn(
          `lightpanda does not provide a binary for ${process.platform}-${process.arch}; skipping download`
        );
        return;
      }

      const cacheDir = resolveCacheDir();
      const binaryName = getBinaryName();
      const binaryPath = path.join(cacheDir, binaryName);

      // 3. Check the cache.
      const manifest = await readManifest(cacheDir);
      const needsUpdate = shouldCheckForUpdate(manifest);

      if (!needsUpdate) {
        // Cached copy is recent enough — verify the binary is still there.
        try {
          await access(binaryPath, fsConstants.X_OK);
          registration.logger.info(
            `lightpanda found in cache (downloaded ${manifest!.downloadedAt})`
          );
          prependToPath(cacheDir);
          return;
        } catch {
          registration.logger.info(
            'lightpanda cache entry missing binary; re-downloading'
          );
        }
      }

      // 4. Download the binary.
      registration.logger.info(
        `downloading lightpanda nightly for ${process.platform}-${process.arch}…`
      );

      try {
        await mkdir(cacheDir, { recursive: true });

        const response = await fetch(downloadUrl);
        if (!response.ok) {
          throw new Error(
            `lightpanda download failed: ${response.status} ${response.statusText}`
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const sha256 = computeSha256(buffer);

        // Write the binary and make it executable.
        await writeFile(binaryPath, buffer);
        await chmod(binaryPath, 0o755);

        // Write the install manifest.
        await writeManifest(cacheDir, {
          version: NIGHTLY_TAG,
          platform: process.platform,
          arch: process.arch,
          downloadedAt: new Date().toISOString(),
          downloadUrl,
          sha256,
        });

        registration.logger.info(
          `lightpanda downloaded to ${binaryPath} (sha256: ${sha256.slice(0, 16)}…)`
        );

        prependToPath(cacheDir);
      } catch (error) {
        registration.logger.error(
          `failed to install lightpanda: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  },
};

/**
 * Prepend the cache directory to `process.env.PATH` so the agent and any
 * spawned child processes can find the `lightpanda` binary.
 */
function prependToPath(cacheDir: string): void {
  const currentPath = process.env.PATH ?? '';
  // Avoid duplicates.
  const parts = currentPath.split(path.delimiter).filter(p => p !== cacheDir);
  parts.unshift(cacheDir);
  process.env.PATH = parts.join(path.delimiter);
}
