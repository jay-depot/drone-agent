// ── Config key allowlists ──────────────────────────────────────────
//
// Canonical source of truth for drone-agent config key paths. The agent's
// config plugin validates `config.set` against KNOWN_CONFIG_KEYS, and the
// coordinator's config pipeline (coordinator → beacon → agent underlay)
// validates distributable keys against UNDERLAY_ALLOWLIST. Keeping both in
// drone-core lets every package share one definition.

/**
 * Full list of known dot-notation config key paths (for validation in
 * `config.set` and provenance tracking). Moved verbatim from the agent's
 * config plugin so the coordinator can share the same definition.
 */
export const KNOWN_CONFIG_KEYS: string[] = [
  // Top-level
  'enabledPlugins',
  'externalPlugins',
  'trustedPlugins',
  'systemPrompt',
  'activePersona',
  'ollama',
  'session',
  'lsp',
  'mcp',
  'compaction',
  'memory',
  'log',
  'promptFile',
  'search',
  // ollama.*
  'ollama.host',
  'ollama.model',
  // session.*
  'session.contextWindowTokens',
  'session.responseReserveTokens',
  'session.maxToolIterations',
  'session.promptOnToolIterationLimit',
  'session.maxToolResultTokensPercent',
  'session.retry.maxRetries',
  'session.retry.maxWaitMs',
  'session.retry.promptOnError',
  'session.retry.backoffBaseMs',
  'session.retry.backoffFactor',
  // llm.*
  'llm.active',
  'llm.reasoningLevel',
  // lsp.*
  'lsp.enabled',
  'lsp.diagnosticTokenBudget',
  'lsp.requestTimeoutMs',
  'lsp.preferExternal',
  'lsp.autoInstall',
  // mcp.*
  'mcp.enabled',
  'mcp.requestTimeoutMs',
  'mcp.retryCount',
  'mcp.retryDelayMs',
  'mcp.maxListPages',
  'mcp.maxListItems',
  'mcp.compatibilityMode',
  // compaction.*
  'compaction.enabled',
  'compaction.strategy',
  'compaction.softThresholdPercent',
  'compaction.slicePercent',
  'compaction.minTurnsToCompact',
  'compaction.summaryMaxTokens',
  'compaction.summaryBudgetPercent',
  // memory.*
  'memory.enabled',
  // log.*
  'log.enabled',
  // promptFile.*
  'promptFile.enabled',
  'promptFile.files',
  // search.*
  'search.enabled',
  'search.paths',
  'search.userEmbeddingProvider',
  'search.projectEmbeddingProvider',
  // wakelock.enabled
  'wakelock.enabled',
];

/**
 * Patterns for config keys the coordinator is allowed to distribute to
 * beacons/agents as a config underlay (narrow MVP, locked decision Q7).
 *
 * - `providers.*` — any provider entry, treated as a whole-entry unit
 * - `llm.active`, `llm.reasoningLevel`
 * - `compaction.enabled`, `compaction.strategy`
 * - `session.guardrail.*` — any guardrail sub-key
 *
 * Matching uses `*` as a single wildcard segment (any suffix).
 */
export const UNDERLAY_ALLOWLIST: string[] = [
  'providers.*',
  'llm.active',
  'llm.reasoningLevel',
  'compaction.enabled',
  'compaction.strategy',
  'session.guardrail.*',
];

/**
 * True when `key` matches one of the UNDERLAY_ALLOWLIST patterns. A trailing
 * `.*` pattern matches any key with that prefix (and at least one following
 * segment); exact patterns match only the literal key.
 */
export function isUnderlayAllowed(key: string): boolean {
  return UNDERLAY_ALLOWLIST.some(pattern => {
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return key.startsWith(prefix) && key.length > prefix.length;
    }
    return key === pattern;
  });
}

/**
 * Wire shape of a config entry as distributed by the coordinator's /api/config
 * and consumed by the beacon's pull + the coordinator UI. `value` is always a
 * JSON string; secret entries are masked on read and never returned in full.
 */
export interface CoordinatorConfigEntry {
  key: string;
  value: string; // JSON string
  secret: boolean;
  description?: string | null;
  updatedAt: number;
}

/**
 * Matches a `${secret:NAME}` reference to a coordinator-stored secret.
 * NAME uses the same charset as environment variables ([A-Za-z0-9_]+), so
 * the receiver-side env-var resolver (which matches [A-Za-z0-9_]+ only)
 * can never confuse a secret reference with an env template — the colon
 * breaks its pattern.
 *
 * Flagged global: never use `.test()`/`.exec()` on this shared instance
 * (lastIndex state leaks between calls); build a fresh RegExp from
 * `.source` when a boolean check is needed.
 */
export const SECRET_REF_PATTERN = /\$\{secret:([A-Za-z0-9_]+)\}/g;

/**
 * Extract the stored-secret names referenced by a config value, in first-
 * occurrence order, deduplicated. Uses a fresh RegExp per call so external
 * mutation of SECRET_REF_PATTERN.lastIndex can never skew the scan.
 */
export function extractSecretRefs(value: string): string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(
    new RegExp(SECRET_REF_PATTERN.source, SECRET_REF_PATTERN.flags)
  )) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * Wire shape of a config entry on the beacon-facing distribution payload
 * (coordinator `GET /api/config/distribution`): every `${secret:NAME}`
 * reference has been substituted with the real stored value. `containsSecrets`
 * marks entries whose resolved value carries secret material — beacons must
 * hold these memory-only and never persist them to disk.
 */
export interface ResolvedConfigEntry extends CoordinatorConfigEntry {
  containsSecrets: boolean;
}
