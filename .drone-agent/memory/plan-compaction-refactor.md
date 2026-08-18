---
key: plan-compaction-refactor
tags:
  - compaction
  - plan
  - architecture
  - bugfix
  - completed
created: 2026-08-17T23:25:36.441Z
updated: 2026-08-18T00:05:34.706Z
---

# Implementation Plan: Compaction Plugin Bug Fixes & Fragment Integration

## Summary
Fix critical string-escaping bugs, restore a lost parameter, integrate prompt fragments for consistent token counting, restore removed documentation, and fix minor issues — all in the compaction plugin on the `fix/compaction-turn-ordering` branch.

## Completion Status: ✅ ALL STEPS DONE (commit 5a5f04d)

1. ✅ Fixed all escaped newline strings (`\\n` → `\n`) in SUMMARY_PREFIX, formatTurnsForSummary, summary prompts, and handleDrop
2. ✅ Fixed broken regex (`/^\\d+$/` → `/^\d+$/`) in handleDrop
3. ✅ Restored `startIndex` parameter to `formatTurnsForSummary` (default 0)
4. ✅ Integrated `buildFragmentMessages` into CompactionPluginDeps, RegistrationContext, runCompaction, and getStatus; wired in index.tsx via engine.renderPromptFragments()
5. ✅ Fixed help text typo ("Context Comp" → "Context Compaction")
6. ✅ Restored JSDoc on emitEvent; added JSDoc on buildFragmentMessages
7. ✅ Restored algorithm-explaining comments (convergence loop, self-purge, slice-and-summarize, summary prepend/tail, failed summary)
8. ✅ Fixed handleDrop type safety (separate const per branch)
9. ✅ Updated all test createCompactionPlugin calls with `buildFragmentMessages: async () => []`
10. ✅ Validation: build, lint, 38 compaction tests, and LSP all pass