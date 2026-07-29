// ── Generic deep merge utility ──────────────────────────────────────
//
// Provides a `deepMerge` function that merges a partial overlay onto a
// base object according to a `MergeSpec` that describes per-field merge
// rules. This replaces the repetitive `applyAgentConfigLayer` function
// with a declarative specification.

/** Describes how each field of an object should be merged. */
export type MergeSpec = {
  /** Fields where the layer value replaces the base value entirely. */
  replace?: string[];
  /** Fields where the layer value is merged into the base via spread (shallow merge). */
  merge?: string[];
  /** Fields where the layer value is recursively deep-merged into the base. */
  deepMerge?: Record<string, MergeSpec>;
  /** Fields where the layer value replaces the base, but null is a valid value. */
  replaceNullable?: string[];
  /** Fields where arrays are merged and deduplicated (not replaced). */
  mergeArrays?: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge a partial overlay onto a base object according to a merge spec.
 *
 * - Fields not present in the overlay (`undefined`) are skipped.
 * - Fields listed in `replace` are set directly from the overlay.
 * - Fields listed in `replaceNullable` are set directly (null is valid).
 * - Fields listed in `merge` are shallow-merged via spread.
 * - Fields listed in `mergeArrays` have their arrays merged and deduplicated.
 * - Fields listed in `deepMerge` are recursively merged with a nested spec.
 * - Unlisted object values default to shallow spread merge (backward compat).
 * - Unlisted scalar values default to replace.
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overlay: Partial<T>,
  spec: MergeSpec
): T {
  const result = { ...base };

  for (const key of Object.keys(overlay) as (keyof T)[]) {
    const value = overlay[key];
    if (value === undefined) continue;

    const keyStr = key as string;

    if (spec.replaceNullable?.includes(keyStr)) {
      // null is a valid value — set it
      (result as Record<string, unknown>)[keyStr] = value;
    } else if (spec.replace?.includes(keyStr)) {
      (result as Record<string, unknown>)[keyStr] = value;
    } else if (spec.mergeArrays?.includes(keyStr) && Array.isArray(value)) {
      const baseArr = (base[key] ?? []) as unknown[];
      (result as Record<string, unknown>)[keyStr] = [
        ...new Set([...baseArr, ...(value as unknown[])]),
      ];
    } else if (spec.merge?.includes(keyStr) && isRecord(value)) {
      (result as Record<string, unknown>)[keyStr] = {
        ...(base[key] as Record<string, unknown>),
        ...value,
      };
    } else if (spec.deepMerge?.[keyStr] && isRecord(value)) {
      const nestedSpec = spec.deepMerge[keyStr];
      (result as Record<string, unknown>)[keyStr] = deepMerge(
        base[key] as Record<string, unknown>,
        value as Record<string, unknown>,
        nestedSpec
      );
    } else if (isRecord(value)) {
      // Default for objects: spread merge (backward compat)
      (result as Record<string, unknown>)[keyStr] = {
        ...(base[key] as Record<string, unknown>),
        ...value,
      };
    } else {
      // Default for scalars: replace
      (result as Record<string, unknown>)[keyStr] = value;
    }
  }

  return result;
}
