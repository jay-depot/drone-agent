---
tags: [decision]
related: [config-cascade.md, DroneAgentConfig.md]
---

# ADR 019: Prompt File Deduplication Across Config Layers

**Status**: Accepted (2026-06-27)

## Context

The config cascade merges layers via `applyAgentConfigLayer` in `drone-core/src/config-types.ts`. For array fields like `promptFile.files`, the original implementation simply concatenated the base and layer arrays:

```typescript
files: layer.promptFile.files
  ? [...baseConfig.promptFile.files, ...layer.promptFile.files]
  : baseConfig.promptFile.files,
```

This caused files specified in both the user config and project config (e.g., `AGENTS.md`) to appear twice in the final resolved config, leading to duplicate content in the system prompt.

## Decision

Wrap the concatenated array in a `Set` to deduplicate:

```typescript
files: layer.promptFile.files
  ? [...new Set([...baseConfig.promptFile.files, ...layer.promptFile.files])]
  : baseConfig.promptFile.files,
```

## Rationale

- **Simplicity**: A one-line change with no new dependencies
- **Correctness**: Duplicate file paths in the resolved config are always a bug — there is no valid use case for injecting the same file twice
- **Order preservation**: `Set` preserves insertion order, so base-layer files come first, then new layer files, matching the existing merge semantics
- **Minimal scope**: Only `promptFile.files` needs this treatment — other array fields like `enabledPlugins` have different merge semantics (additive, not concatenative)

## Consequences

- Duplicate file paths across config layers are silently removed
- First occurrence wins (base layer first, then user, then project)
- All unique files from both layers are preserved
- A test was added to verify the deduplication behavior

## Implementation

- **File**: `drone-core/src/config-types.ts` (lines 432–438 in `applyAgentConfigLayer`)
- **Test**: `drone-agent/test/prompt-file.test.ts` — test `'merges and deduplicates promptFile.files across layers'`
- **Commit**: `d44a8fde` (refactor: unify slash command dispatch through engine registry)

## Related

- [config-cascade](005-config-cascade.md) — Config layering
- [DroneAgentConfig](../../drone-core/src/config-types.ts) — Config schema
