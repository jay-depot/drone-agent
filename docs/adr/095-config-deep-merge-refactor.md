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
  replace?: string[];        // Layer value replaces base entirely
  merge?: string[];           // Layer value is shallow-merged via spread
  deepMerge?: Record<string, MergeSpec>;  // Recursive deep merge with nested spec
  replaceNullable?: string[]; // Like replace, but null is a valid value
  mergeArrays?: string[];    // Arrays are merged and deduplicated
};
```

### CONFIG_MERGE_SPEC

```typescript
const CONFIG_MERGE_SPEC: MergeSpec = {
  replace: ['enabledPlugins', 'externalPlugins', 'systemPrompt'],
  replaceNullable: ['activePersona'],
  merge: ['trustedPlugins', 'llm', 'ollama', 'session', 'compaction', 'memory', 'log', 'terminal'],
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
```

### Behavior preserved

| Field | Merge Rule | Notes |
|-------|-----------|-------|
| `enabledPlugins` | Replace | Additive behavior is handled by caller |
| `externalPlugins` | Replace | |
| `trustedPlugins` | Merge objects | `{ ...base, ...layer }` |
| `systemPrompt` | Replace | |
| `activePersona` | Replace (nullable) | `null` is a valid value (explicit clear) |
| `llm` | Spread merge | |
| `ollama` | Spread merge | |
| `openai` | Spread merge, replace `models` | `models` is an array, layer replaces |
| `anthropic` | Spread merge, replace `models` | |
| `openrouter` | Spread merge, replace `models` | |
| `session` | Spread merge | |
| `lsp` | Spread merge, replace `servers` | `servers` is a record, layer replaces |
| `mcp` | Spread merge, replace `servers` | |
| `compaction` | Spread merge | |
| `memory` | Spread merge | |
| `log` | Spread merge | |
| `terminal` | Spread merge | |
| `promptFile` | Spread merge, merge+dedup `files` | `files` is an array, merged with Set |
| `swarm` | Spread merge, spread merge `knowledgeSync` | Nested object merge |
| `tui` | Spread merge, spread merge `syntaxHighlighting`, spread merge `syntaxHighlighting.colors` | 3 levels deep |

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

- [[config-cascade]] — How config layers work
- [[entities/DroneAgentConfig]] — Full config schema
- [[modules/drone-core]] — The drone-core package
