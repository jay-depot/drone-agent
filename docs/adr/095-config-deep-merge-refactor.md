---
tags: [decision, refactor]
related: [config-cascade.md, DroneAgentConfig.md, drone-core.md]
---

# 095 — Config Deep Merge Refactor

**Summary**: Replaced the 450-line `applyAgentConfigLayer` function in `drone-core/src/config-types.ts` with a generic `deepMerge` utility driven by a declarative `MergeSpec`. This eliminates ~20 near-identical if-blocks and makes adding new config sections a one-line change.

## Context

The `applyAgentConfigLayer` function merged a `PartialDroneAgentConfig` layer onto a `DroneAgentConfig` base. It had ~20 near-identical `if (layer.X) { ...baseConfig.X, ...layer.X }` blocks, each with slightly different handling for nested objects, arrays, and special cases (e.g., `models` arrays replaced, `files` arrays merged+deduped, `tui.syntaxHighlighting.colors` merged 3 levels deep).

Every time a new config section was added, the function needed a new block. The function was 136 lines of repetitive code.

## Decision

Create a generic `deepMerge` function in a new `drone-core/src/deep-merge.ts` module, with a `MergeSpec` type that describes per-field merge rules declaratively.

### MergeSpec

```typescript
type MergeSpec = {
  replace?: string[]; // Layer value replaces base entirely
  merge?: string[]; // Layer value is shallow-merged via spread
  deepMerge?: Record<string, MergeSpec>; // Recursive deep merge with nested spec
  replaceNullable?: string[]; // Like replace, but null is a valid value
  mergeArrays?: string[]; // Arrays are merged and deduplicated
  mergeMaps?: string[]; // Named-entry maps merged entry-by-entry (null entry deletes)
};
```

### CONFIG_MERGE_SPEC

```typescript
const CONFIG_MERGE_SPEC: MergeSpec = {
  replace: ['externalPlugins', 'systemPrompt'],
  replaceNullable: ['activePersona'],
  mergeMaps: ['enabledPlugins', 'trustedPlugins', 'providers'],
  merge: [
    'ollama',
    'compaction',
    'memory',
    'wakelock',
    'checkpoint',
    'herdr',
    'log',
    'terminal',
    'search',
  ],
  deepMerge: {
    openai: { replace: ['models'] },
    anthropic: { replace: ['models'] },
    openrouter: { replace: ['models'] },
    lsp: { mergeMaps: ['servers'] },
    mcp: { mergeMaps: ['servers'] },
    promptFile: { mergeArrays: ['files'] },
    llm: { deepMerge: { modelRoles: {} } },
    session: {
      deepMerge: { guardrail: { deepMerge: {} }, retry: { deepMerge: {} } },
    },
    swarm: { deepMerge: { knowledgeSync: {}, sessionImport: {}, memory: {} } },
    tui: { deepMerge: { syntaxHighlighting: { deepMerge: { colors: {} } } } },
  },
};
```

> The `mergeMaps` rule kind replaced the per-map `replace` behavior in ADR 251
> (`enabledPlugins` became an override map; `lsp.servers`/`mcp.servers` — and,
> for consistency, `providers`/`trustedPlugins` — became 1-level merges with
> `null`-delete semantics).

### Behavior preserved

| Field             | Merge Rule                                                                                | Notes                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `enabledPlugins`  | `mergeMaps` (entry-level merge; null clears)                                              | Override map over the default plugin base; engine resolves |
| `externalPlugins` | Replace                                                                                   |                                                            |
| `trustedPlugins`  | Merge objects                                                                             | `{ ...base, ...layer }`                                    |
| `systemPrompt`    | Replace                                                                                   |                                                            |
| `activePersona`   | Replace (nullable)                                                                        | `null` is a valid value (explicit clear)                   |
| `llm`             | Spread merge                                                                              |                                                            |
| `ollama`          | Spread merge                                                                              |                                                            |
| `openai`          | Spread merge, replace `models`                                                            | `models` is an array, layer replaces                       |
| `anthropic`       | Spread merge, replace `models`                                                            |                                                            |
| `openrouter`      | Spread merge, replace `models`                                                            |                                                            |
| `session`         | Spread merge                                                                              |                                                            |
| `lsp`             | Spread merge, `mergeMaps` `servers`                                                       | `servers` 1-level merge; null entry deletes                |
| `mcp`             | Spread merge, `mergeMaps` `servers`                                                       |                                                            |
| `compaction`      | Spread merge                                                                              |                                                            |
| `memory`          | Spread merge                                                                              |                                                            |
| `log`             | Spread merge                                                                              |                                                            |
| `terminal`        | Spread merge                                                                              |                                                            |
| `promptFile`      | Spread merge, merge+dedup `files`                                                         | `files` is an array, merged with Set                       |
| `swarm`           | Spread merge, spread merge `knowledgeSync`                                                | Nested object merge                                        |
| `tui`             | Spread merge, spread merge `syntaxHighlighting`, spread merge `syntaxHighlighting.colors` | 3 levels deep                                              |

### TypeScript consideration

`deepMerge` returns `T` (which is `Record<string, unknown>`), but the actual `DroneAgentConfig` has required fields that `Partial<DroneLlmConfig>` etc. can make optional. A single `as DroneAgentConfig` cast at the call site was the cleanest solution.

## Consequences

- **Positive**: `config-types.ts` reduced from 639 to 537 lines
- **Positive**: Adding a new config section is now a one-line addition to `CONFIG_MERGE_SPEC`
- **Positive**: The `deepMerge` utility is generic and reusable for any object merging
- **Positive**: All 1647 existing tests pass unchanged
- **Neutral**: One `as DroneAgentConfig` type assertion at the call site
- **Neutral**: The `deepMerge` function and `MergeSpec` type are now exported from `drone-core` for external use

## Related

- [config-cascade](005-config-cascade.md) — How config layers work
- [DroneAgentConfig](../../drone-core/src/config-types.ts) — Full config schema
- [drone-core](../../drone-core/) — The drone-core package
