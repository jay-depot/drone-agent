/**
 * Config-key completion + the distribution allowlist, in one module so the
 * Config page and the suggestion logic share a single source of truth.
 * Mirrors UNDERLAY_ALLOWLIST in drone-core (drone-core is not directly
 * importable from this web package; keep in sync manually).
 */
export const ALLOWLIST_PATTERNS = [
  'providers.*',
  'llm.active',
  'llm.reasoningLevel',
  'compaction.enabled',
  'compaction.strategy',
  'session.guardrail.*',
];

/**
 * Compute key-completion suggestions for the Config "Add" key input.
 *
 * Candidates = the set of already-existing config keys unioned with the
 * distribution allowlist patterns. A wildcard pattern like `providers.*`
 * contributes the prefix stem `providers.` (so typing `providers.` suggests
 * the dot to finish the wildcard family; individual `providers.<id>` keys
 * appear because they already exist). An exact pattern contributes itself.
 *
 * Suggestions are filtered to those starting with `query`, drop an exact
 * match for the current query, sorted lexicographically, and capped at 8 so
 * the dropdown stays small. Pure function — no React, no fetch.
 */
export function computeKeySuggestions(
  query: string,
  existingKeys: string[],
  patterns: string[] = ALLOWLIST_PATTERNS
): string[] {
  const seen = new Set<string>();
  const push = (key: string) => {
    if (!seen.has(key)) {
      seen.add(key);
    }
  };
  for (const key of existingKeys) {
    push(key);
  }
  for (const pattern of patterns) {
    if (pattern.endsWith('.*')) {
      push(pattern.slice(0, -1)); // `providers.*` -> `providers.`
    } else {
      push(pattern);
    }
  }
  return [...seen]
    .filter(key => key.startsWith(query) && key !== query)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 8);
}
