---
key: prompt-file-deduplicate-fix
tags:
  - bug-fix
  - config
  - prompt-file
created: 2026-06-27T22:57:10.558Z
updated: 2026-06-27T22:57:10.558Z
---

## Implementation Plan: promptFile.files Merge & Deduplicate Fix

### Bug Description

AGENTS.md was being added to context twice due to additive array merging in config layers.

### Root Cause

In `drone-core/src/config-types.ts`, the `applyAgentConfigLayer` function concatenates `promptFile.files` arrays:

```typescript
files: layer.promptFile.files
  ? [...baseConfig.promptFile.files, ...layer.promptFile.files]
  : baseConfig.promptFile.files,
```

### Proposed Fix

Change to merge and deduplicate using a Set:

```typescript
files: layer.promptFile.files
  ? [...new Set([...baseConfig.promptFile.files, ...layer.promptFile.files])]
  : baseConfig.promptFile.files,
```

### Files to Modify

1. `drone-core/src/config-types.ts` - Update applyAgentConfigLayer function
2. `drone-agent/test/prompt-file.test.ts` - Update test for deduplication behavior

### Test Considerations

- Duplicates should be removed (first occurrence wins)
- Order should be preserved
- All non-duplicate files from both layers should be preserved
