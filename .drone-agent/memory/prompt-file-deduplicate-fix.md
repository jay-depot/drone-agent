---
key: prompt-file-deduplicate-fix
tags:
  - bug-fix
  - config
  - prompt-file
  - completed
created: 2026-06-27T22:57:10.558Z
updated: 2026-06-29T18:21:30.485Z
---

## Implementation Plan: promptFile.files Merge & Deduplicate Fix

### Status: ✅ COMPLETED

### Bug Description

AGENTS.md was being added to context twice due to additive array merging in config layers.

### Root Cause

In `drone-core/src/config-types.ts`, the `applyAgentConfigLayer` function concatenated `promptFile.files` arrays without deduplication.

### Fix Applied

**Commit:** `d44a8fde` ("refactor: unify slash command dispatch through engine registry")

**Files modified:**

1. **`drone-core/src/config-types.ts`** — Updated `applyAgentConfigLayer` to use `new Set([...])` for deduplication:
   ```typescript
   files: layer.promptFile.files
     ? [...new Set([...baseConfig.promptFile.files, ...layer.promptFile.files])]
     : baseConfig.promptFile.files,
   ```

2. **`drone-agent/test/prompt-file.test.ts`** — Added test `'merges and deduplicates promptFile.files across layers'` that verifies:
   - Duplicates are removed (first occurrence wins)
   - Order is preserved
   - All non-duplicate files from both layers are preserved

### Verification

- The deduplication logic is in place at line 432-438 of `config-types.ts`
- The test at line 186 of `prompt-file.test.ts` passes with the expected behavior
- The comment `// Merge and deduplicate files from both layers` was added in commit `fd21a3dc`