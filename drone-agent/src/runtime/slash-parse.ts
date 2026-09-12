import type { DroneSlashInvocation } from 'drone-core';

/**
 * Shared slash-command line parsing helpers.
 *
 * These live at the runtime level (not in drone-core) because they are
 * engine-side utilities consumed by classification, dispatch, queueing, and
 * the TUI host. `DroneSlashInvocation` itself is defined in drone-core so
 * plugins can type `busyBehavior` classifiers against it.
 */

/**
 * Parse the portion of a slash-command line that follows the command token
 * into its subcommand (first non-flag token) and flags (dash-prefixed
 * tokens, in order).
 *
 * Examples:
 *   parseSlashInvocation('set clear')        → { subcommand: 'set', flags: [] }
 *   parseSlashInvocation('--all')            → { subcommand: undefined, flags: ['all'] }
 *   parseSlashInvocation('unmount --all')    → { subcommand: 'unmount', flags: ['all'] }
 *   parseSlashInvocation('')                 → { subcommand: undefined, flags: [] }
 */
export function parseSlashInvocation(rest: string): DroneSlashInvocation {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const flags: string[] = [];
  let subcommand: string | undefined;
  for (const token of tokens) {
    if (token.startsWith('-')) {
      flags.push(token.replace(/^--?/, ''));
    } else if (subcommand === undefined) {
      subcommand = token;
    }
  }
  return { subcommand, flags };
}

/**
 * Strip a leading `--now` flag from a slash-command line. The `--now` flag
 * overrides queue→immediate for queued commands and must never leak into a
 * handler's args. Returns `{ line, hadNow }` where `line` is the command
 * line with a single `--now` stripped (only the FIRST occurrence, matching
 * how `--now` is a v1 escape hatch rather than a repeatable flag).
 */
export function stripNowFlag(line: string): { line: string; hadNow: boolean } {
  // Match `--now` as its own whitespace-delimited token. The command itself
  // (`/clear --now`) or a trailing position (`/focus set clear --now`) are
  // both valid; `--now` mid-subcommand is not (it would be a normal arg).
  const parted = line.split(/\s+/);
  const idx = parted.indexOf('--now');
  if (idx === -1) {
    return { line, hadNow: false };
  }
  parted.splice(idx, 1);
  return { line: parted.join(' '), hadNow: true };
}
