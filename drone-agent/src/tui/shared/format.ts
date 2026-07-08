/**
 * Shared formatting helpers for the TUI.
 *
 * Single source of truth for the helpers that were previously duplicated
 * across `app.tsx`, `diff-format.ts`, `ToolCallProgress.tsx`, and
 * `GitDiffBlock.tsx`. The tail components (`ToolCallProgress`, `GitDiffBlock`)
 * and the App commit flow all import from here so there is exactly one
 * implementation of each.
 */

/** Maximum chars rendered in a tool argument or result preview. */
export const PREVIEW_MAX = 200;

/** Flatten whitespace and trim, truncating to `max` chars with an ellipsis. */
export function preview(text: string, max = PREVIEW_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Parse a JSON string into a non-array object, or undefined on failure. */
export function tryParseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
