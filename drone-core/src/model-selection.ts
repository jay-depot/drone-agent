import type { DroneAgentConfig, DroneReasoningLevel } from './config-types.js';

// ── Canonical model selection identity ─────────────────────────────
//
// A selected model is canonically `<providerId>/<modelLocalId>`, split on
// the FIRST slash so multi-slash upstream ids (OpenRouter-style) survive:
// `openrouter/anthropic/claude-opus-4.8` → provider `openrouter`,
// local id `anthropic/claude-opus-4.8`.

export type ModelSelection = {
  providerId: string;
  modelLocalId: string;
};

/**
 * Well-known model-role names that built-in plugins bind via
 * `llm.modelRoles`. The namespace is open — any plugin may mint additional
 * roles — but these names are recognized by the startup validator (unknown
 * names warn to catch typos) and documented for shared use.
 */
export const WELL_KNOWN_MODEL_ROLES = [
  'summarizer',
  'wizard',
  'describer',
  'image_describer',
] as const;

/** Any well-known role name, or an arbitrary plugin-defined role. */
export type DroneModelRole =
  | (typeof WELL_KNOWN_MODEL_ROLES)[number]
  | (string & {});

/**
 * Parse a canonical `<providerId>/<modelLocalId>` string, splitting on the
 * first slash. Returns undefined when there is no slash (bare ids are an
 * interactive-only convenience and are never valid config values).
 */
export function parseModelSelection(
  selection: string
): ModelSelection | undefined {
  const slashIndex = selection.indexOf('/');
  if (slashIndex <= 0 || slashIndex === selection.length - 1) {
    return undefined;
  }
  return {
    providerId: selection.slice(0, slashIndex),
    modelLocalId: selection.slice(slashIndex + 1),
  };
}

/** Format a parsed selection back into its canonical string form. */
export function formatModelSelection(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelLocalId}`;
}

/**
 * Strict form used for config values: must be a full
 * `<providerId>/<modelLocalId>` pair with non-empty halves.
 */
export function isValidFullModelSelection(selection: string): boolean {
  return parseModelSelection(selection) !== undefined;
}

/**
 * Resolve the configured reasoning level for a model selection: the selected
 * model entry's `reasoningLevel`, else the `llm.reasoningLevel` fallback. The
 * conversation service keeps its session-level override AHEAD of this helper;
 * role-bound callers use it directly (no session override exists for them).
 */
export function resolveConfiguredReasoningLevel(
  config: Pick<DroneAgentConfig, 'providers' | 'llm'>,
  selection: { providerId: string; modelLocalId: string }
): DroneReasoningLevel | undefined {
  return (
    config.providers[selection.providerId]?.models?.[selection.modelLocalId]
      ?.reasoningLevel ?? config.llm.reasoningLevel
  );
}

/**
 * Lenient interactive resolution: a bare id (no slash) is accepted as a
 * shorthand within the active provider.
 */
export function resolveInteractiveSelection(
  selection: string,
  activeProviderId: string
): { full: string; selection: ModelSelection } | undefined {
  if (parseModelSelection(selection)) {
    return resolveFullUnchecked(selection);
  }
  if (!activeProviderId || !selection) {
    return undefined;
  }
  return resolveFullUnchecked(`${activeProviderId}/${selection}`);
}

function resolveFullUnchecked(full: string): {
  full: string;
  selection: ModelSelection;
} {
  // parseModelSelection was already proven to succeed by callers.
  const selection = parseModelSelection(full)!;
  return { full, selection };
}
