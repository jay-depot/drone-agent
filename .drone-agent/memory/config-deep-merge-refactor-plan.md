---
key: config-deep-merge-refactor-plan
tags:
  - plan
  - refactor
  - config
created: 2026-07-28T19:53:29.319Z
updated: 2026-07-28T19:53:29.319Z
---

# Config Deep Merge Refactor Plan

## Summary

Replace the 450-line `applyAgentConfigLayer` function in `drone-core/src/config-types.ts` with a generic deep-merge utility. The current function has ~20 near-identical `if (layer.X) { ...baseConfig.X, ...layer.X }` blocks, each with slightly different handling for nested objects, arrays, and special cases. A generic approach eliminates this repetition and makes adding new config sections a one-line change.

## Current Behavior (must preserve)

The function merges a `PartialDroneAgentConfig` layer onto a `DroneAgentConfig` base. The merge rules per field are:

| Field             | Merge Rule                                                                                | Notes                                    |
| ----------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------- |
| `enabledPlugins`  | Replace                                                                                   | Additive behavior is handled by caller   |
| `externalPlugins` | Replace                                                                                   |                                          |
| `trustedPlugins`  | Merge objects                                                                             | `{ ...base, ...layer }`                  |
| `systemPrompt`    | Replace                                                                                   |                                          |
| `activePersona`   | Replace (nullable)                                                                        | `null` is a valid value (explicit clear) |
| `llm`             | Spread merge                                                                              | `{ ...base.llm, ...layer.llm }`          |
| `ollama`          | Spread merge                                                                              |                                          |
| `openai`          | Spread merge, replace `models`                                                            | `models` is an array, layer replaces     |
| `anthropic`       | Spread merge, replace `models`                                                            |                                          |
| `openrouter`      | Spread merge, replace `models`                                                            |                                          |
| `session`         | Spread merge                                                                              |                                          |
| `lsp`             | Spread merge, replace `servers`                                                           | `servers` is a record, layer replaces    |
| `mcp`             | Spread merge, replace `servers`                                                           |                                          |
| `compaction`      | Spread merge                                                                              |                                          |
| `memory`          | Spread merge                                                                              |                                          |
| `log`             | Spread merge                                                                              |                                          |
| `terminal`        | Spread merge                                                                              |                                          |
| `promptFile`      | Spread merge, merge+dedup `files`                                                         | `files` is an array, merged with Set     |
| `swarm`           | Spread merge, spread merge `knowledgeSync`                                                | Nested object merge                      |
| `tui`             | Spread merge, spread merge `syntaxHighlighting`, spread merge `syntaxHighlighting.colors` | 3 levels deep                            |

## Design

### New file: `drone-core/src/deep-merge.ts`

A generic `deepMerge` function that takes a base object and a partial overlay, with a merge specification that describes how each field should be handled.

```typescript
type MergeSpec = {
  /** Fields where the layer value replaces the base value entirely (default behavior). */
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
```

The `applyAgentConfigLayer` function then becomes:

```typescript
const CONFIG_MERGE_SPEC: MergeSpec = {
  replace: ['enabledPlugins', 'externalPlugins', 'systemPrompt'],
  replaceNullable: ['activePersona'],
  merge: [
    'trustedPlugins',
    'llm',
    'ollama',
    'session',
    'compaction',
    'memory',
    'log',
    'terminal',
  ],
  deepMerge: {
    openai: { replace: ['models'] },
    anthropic: { replace: ['models'] },
    openrouter: { replace: ['models'] },
    lsp: { replace: ['servers'] },
    mcp: { replace: ['servers'] },
    promptFile: { mergeArrays: ['files'] },
    swarm: { deepMerge: { knowledgeSync: {} } },
    tui: { deepMerge: { syntaxHighlighting: { deepMerge: { colors: {} } } } },
  },
};

export function applyAgentConfigLayer(
  baseConfig: DroneAgentConfig,
  layer: PartialDroneAgentConfig
): DroneAgentConfig {
  return deepMerge(baseConfig, layer, CONFIG_MERGE_SPEC);
}
```

### `deepMerge` function signature

```typescript
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overlay: Partial<T>,
  spec: MergeSpec
): T;
```

### Implementation sketch

```typescript
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  overlay: Partial<T>,
  spec: MergeSpec
): T {
  const result = { ...base };

  for (const key of Object.keys(overlay) as (keyof T)[]) {
    const value = overlay[key];
    if (value === undefined) continue;

    if (spec.replaceNullable?.includes(key as string)) {
      // null is a valid value — set it
      (result as Record<string, unknown>)[key as string] = value;
    } else if (spec.replace?.includes(key as string)) {
      (result as Record<string, unknown>)[key as string] = value;
    } else if (
      spec.mergeArrays?.includes(key as string) &&
      Array.isArray(value)
    ) {
      const baseArr = (base[key] ?? []) as unknown[];
      (result as Record<string, unknown>)[key as string] = [
        ...new Set([...baseArr, ...(value as unknown[])]),
      ];
    } else if (spec.merge?.includes(key as string) && isRecord(value)) {
      (result as Record<string, unknown>)[key as string] = {
        ...(base[key] as Record<string, unknown>),
        ...value,
      };
    } else if (spec.deepMerge?.[key as string] && isRecord(value)) {
      const nestedSpec = spec.deepMerge[key as string];
      (result as Record<string, unknown>)[key as string] = deepMerge(
        base[key] as Record<string, unknown>,
        value as Record<string, unknown>,
        nestedSpec
      );
    } else if (isRecord(value)) {
      // Default for objects: spread merge (backward compat)
      (result as Record<string, unknown>)[key as string] = {
        ...(base[key] as Record<string, unknown>),
        ...value,
      };
    } else {
      // Default for scalars: replace
      (result as Record<string, unknown>)[key as string] = value;
    }
  }

  return result;
}
```

## Steps

### Step 1: Create `drone-core/src/deep-merge.ts`

- Implement `deepMerge` function and `MergeSpec` type
- Include `isRecord` helper (or import from utils)
- Export both

### Step 2: Update `drone-core/src/config-types.ts`

- Define `CONFIG_MERGE_SPEC` constant
- Replace `applyAgentConfigLayer` body with `deepMerge(baseConfig, layer, CONFIG_MERGE_SPEC)` call
- Keep the function signature and export unchanged

### Step 3: Update `drone-core/src/index.ts`

- Export `deepMerge` and `MergeSpec` from the new module

### Step 4: Update tests in `drone-core/test/index.test.ts`

- All existing tests must pass unchanged (the function signature is the same)
- Add a test for the `deepMerge` function directly
- Add a test for `tui` nested merge (currently untested)
- Add a test for `promptFile.files` merge+dedup (currently untested)

### Step 5: Validation

1. `pnpm -r run build` — must pass
2. `pnpm -r run lint` — must pass
3. `pnpm -r run test` — must pass (all existing config merge tests)
4. LSP diagnostics — must be clean
5. Manual: verify that a real config file with user+project layers produces the same merged result as before

## Validation Criteria

- All existing tests pass without modification
- No regressions in config loading behavior
- The function signature and export path remain unchanged (no callers need updating)
- LSP, build, lint, and test all pass
