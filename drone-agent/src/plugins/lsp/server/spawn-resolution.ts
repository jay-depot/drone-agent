import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { DroneLspServerConfig, DroneLogger } from 'drone-core';
import { commandExistsOnPath } from 'drone-core';
import {
  computeCacheKey,
  ensureServerInstalled,
  resolveCacheDir,
  type InstallerSpec,
} from '../installer.js';
import type { KnownServerSpec } from '../known-servers.js';

export type ResolvedSpawn = {
  command: string;
  args: string[];
  source: 'path' | 'cache';
  cacheDir?: string;
  installStatus: 'unused' | 'cached' | 'downloaded';
};

/**
 * Resolve the spawn command for a configured stdio server:
 * 1. Use the user's command as-is when it resolves on PATH.
 * 2. Otherwise auto-install into the per-user cache when enabled and we
 *    have install metadata for the server.
 * TCP configs are user-managed and resolve to null (no spawn).
 */
export async function resolveServerCommand(
  serverId: string,
  _language: string,
  config: DroneLspServerConfig,
  knownSpec: KnownServerSpec | undefined,
  lspAutoInstall: boolean,
  logger: DroneLogger
): Promise<ResolvedSpawn | null> {
  if (config.transport === 'tcp') {
    return null;
  }

  const userAutoInstall =
    config.transport === 'stdio' && config.autoInstall !== undefined
      ? config.autoInstall
      : undefined;
  const autoInstall = userAutoInstall ?? lspAutoInstall;

  if (await commandExistsOnPath(config.command)) {
    return {
      command: config.command,
      args: config.args ?? [],
      source: 'path',
      installStatus: 'unused',
    };
  }

  const installSpec =
    knownSpec?.install ??
    (config.transport === 'stdio' && config.command === knownSpec?.command
      ? knownSpec?.install
      : undefined);

  if (!autoInstall || !installSpec) {
    throw new Error(
      `${config.command} not found on PATH and auto-install is disabled.`
    );
  }

  const installerSpec: InstallerSpec = {
    id: serverId,
    command: config.command,
    args: config.args ?? [],
    install: installSpec,
  };

  const wasCached = await (async () => {
    const cacheRoot = resolveCacheDir();
    const cacheKey = computeCacheKey({
      serverId,
      version: installSpec.version,
    });
    const cacheDir = path.join(
      cacheRoot,
      serverId,
      installSpec.version,
      cacheKey
    );
    const entry = path.join(cacheDir, installSpec.entryPoint ?? config.command);
    try {
      await access(entry, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  })();

  const resolution = await ensureServerInstalled(installerSpec, {
    logger,
  });

  return {
    command: resolution.command,
    args: resolution.args,
    cacheDir: resolution.cacheDir,
    source: resolution.source,
    installStatus: wasCached ? 'cached' : 'downloaded',
  };
}
