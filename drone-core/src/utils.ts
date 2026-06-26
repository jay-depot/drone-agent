// ── Utility functions ──────────────────────────────────────────────

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

export function createConsoleLogger(scope: string): DroneLogger {
  return {
    info: message => console.log(`[${scope}] ${message}`),
    warn: message => console.warn(`[${scope}] ${message}`),
    error: message => console.error(`[${scope}] ${message}`),
  };
}

export function getCanonicalToolName(
  pluginId: string,
  toolName: string
): string {
  return `${pluginId}.${toolName}`;
}