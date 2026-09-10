import fs from 'node:fs/promises';
import path from 'node:path';
import type { SpawnRootsConfig } from 'drone-swarm-common';
import { logger } from './logger.js';

/**
 * Beacon spawn working-directory roots (decision 8 of the remote-spawn
 * lifecycle plan). The beacon advertises its whitelisted roots to the
 * coordinator and enforces the whitelist at spawn time.
 *
 * The module holds the current expanded root set + default in memory. Globs
 * (`/path/*`) expand to concrete immediate-child dirs at load and on periodic
 * re-scan; literals are kept as-is. The default must be one of the expanded
 * roots; if not, it falls back to the first expanded root with a warning.
 */

let currentRoots: string[] = [];
let currentDefault = '';
let config: SpawnRootsConfig | null = null;
let onChange: (() => void) | null = null;

/**
 * Register a callback invoked whenever the expanded root set changes (e.g. on
 * a periodic re-scan). The beacon index wires this to re-advertise the roots
 * to the coordinator.
 */
export function setSpawnRootsChangeListener(cb: () => void): void {
  onChange = cb;
}

/**
 * Expand a list of root entries into concrete absolute paths. Entries ending
 * in `/*` expand to their immediate child directories; all other entries are
 * kept as literal paths. Results are deduplicated and sorted.
 */
export async function expandSpawnRoots(paths: string[]): Promise<string[]> {
  const expanded = new Set<string>();
  for (const entry of paths) {
    if (entry.endsWith('/*')) {
      const base = entry.slice(0, -2);
      try {
        const entries = await fs.readdir(base, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            expanded.add(path.resolve(base, e.name));
          }
        }
      } catch {
        // Missing/unreadable base dir — skip the glob (no children to add).
      }
    } else {
      expanded.add(path.resolve(entry));
    }
  }
  return [...expanded].sort();
}

/**
 * Resolve a spawnRoots config into the expanded root set and the effective
 * default. The default must be one of the expanded roots; if it is not, a
 * warning is logged and the first expanded root is used instead.
 */
export async function resolveSpawnRoots(
  cfg: SpawnRootsConfig
): Promise<{ roots: string[]; defaultRoot: string }> {
  const roots = await expandSpawnRoots(cfg.paths);
  let defaultRoot = path.resolve(cfg.default);
  if (!roots.includes(defaultRoot)) {
    logger.warn(
      `spawnRoots.default "${cfg.default}" is not in the expanded root set; falling back to "${roots[0] ?? ''}"`
    );
    defaultRoot = roots[0] ?? '';
  }
  return { roots, defaultRoot };
}

/**
 * Initialize the module from a spawnRoots config. Expands globs and resolves
 * the default. Call once at beacon startup.
 */
export async function initSpawnRoots(cfg: SpawnRootsConfig): Promise<void> {
  config = cfg;
  const { roots, defaultRoot } = await resolveSpawnRoots(cfg);
  currentRoots = roots;
  currentDefault = defaultRoot;
  logger.info(
    `Spawn roots: ${roots.length} root(s), default=${defaultRoot || '(none)'}`
  );
}

/**
 * Re-expand the configured roots (e.g. on a periodic interval) and update the
 * in-memory set. Fires the change listener so the beacon can re-advertise to
 * the coordinator. Returns the new root set.
 */
export async function rescanSpawnRoots(): Promise<string[]> {
  if (!config) return currentRoots;
  const { roots, defaultRoot } = await resolveSpawnRoots(config);
  currentRoots = roots;
  currentDefault = defaultRoot;
  onChange?.();
  return roots;
}

/** The current expanded root set. */
export function getSpawnRoots(): string[] {
  return currentRoots;
}

/** The current effective default root. */
export function getDefaultSpawnRoot(): string {
  return currentDefault;
}

/**
 * True when `workingDir` is within the expanded root set. Used by
 * handleSpawnAgent to enforce the whitelist.
 */
export function isSpawnRootAllowed(workingDir: string): boolean {
  return currentRoots.includes(path.resolve(workingDir));
}
