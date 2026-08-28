// ── Utility functions ──────────────────────────────────────────────

import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { sep, join } from 'node:path';

import type { DroneLogger } from './session-types.js';

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports `*` (match any sequence of characters) and `?` (match any single char).
 * The pattern is anchored to the full string.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Match a name against a single glob pattern.
 * Supports `*` and `?` wildcards.
 */
export function matchGlob(pattern: string, name: string): boolean {
  return globToRegex(pattern).test(name);
}

/**
 * Filter a list of items by inclusion/exclusion glob patterns.
 *
 * - If `patterns` is empty or undefined, all items are returned.
 * - Patterns starting with `!` are exclusion patterns (the `!` is stripped).
 * - Items matching at least one inclusion pattern AND not matching any
 *   exclusion pattern are returned.
 * - If no inclusion patterns are given (all patterns are `!`-prefixed),
 *   all items are included by default (only exclusions apply).
 */
export function filterByGlobPatterns(
  items: string[],
  patterns: string[] | undefined
): string[] {
  if (!patterns || patterns.length === 0) {
    return [...items];
  }

  const inclusions: string[] = [];
  const exclusions: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      exclusions.push(pattern.slice(1));
    } else {
      inclusions.push(pattern);
    }
  }

  const hasInclusions = inclusions.length > 0;

  return items.filter(item => {
    // Must match at least one inclusion pattern (or all items if no inclusions)
    if (hasInclusions && !inclusions.some(p => matchGlob(p, item))) {
      return false;
    }
    // Must not match any exclusion pattern
    if (exclusions.some(p => matchGlob(p, item))) {
      return false;
    }
    return true;
  });
}

// ── Logger factory ─────────────────────────────────────────────────

export function createConsoleLogger(
  scope: string,
  options: { toStderr?: boolean } = {}
): DroneLogger {
  const { toStderr = false } = options;
  return {
    info: message =>
      toStderr
        ? console.error(`[${scope}] ${message}`)
        : console.log(`[${scope}] ${message}`),
    warn: message => console.warn(`[${scope}] ${message}`),
    error: message => console.error(`[${scope}] ${message}`),
  };
}

export function getCanonicalToolName(
  pluginId: string,
  toolName: string
): string {
  return `${pluginId}__${toolName}`;
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
  if (command.includes(sep) || command.includes('/')) {
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
      const candidate = join(directory, command + ext);
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

export interface ResolveDroneExecutableOptions {
  commandName?: string;
  env?: NodeJS.ProcessEnv;
  fallbackArgv1?: string;
}

export async function resolveDroneExecutable(
  options: ResolveDroneExecutableOptions = {}
): Promise<string> {
  const {
    commandName = 'drone-agent',
    env = process.env,
    fallbackArgv1,
  } = options;

  if (await commandExistsOnPath(commandName, env)) {
    return commandName;
  }

  if (fallbackArgv1 && (await commandExistsOnPath(fallbackArgv1, env))) {
    return fallbackArgv1;
  }

  throw new Error(
    fallbackArgv1
      ? `Unable to resolve executable "${commandName}" from PATH or fallback path "${fallbackArgv1}".`
      : `Unable to resolve executable "${commandName}" from PATH.`
  );
}
