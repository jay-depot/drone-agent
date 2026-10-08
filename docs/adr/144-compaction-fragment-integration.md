---
tags: [decision, compaction, fragment, token-counting]
related:
  [
    concepts/session-management.md,
    decisions/134-compaction-correctness-fix.md,
    decisions/135-compaction-slash-command.md,
    decisions/142-compaction-turn-granularity-fix.md,
  ]
---

# 144: Compaction Refactor — String-Escaping Fixes + `buildFragmentMessages` Integration

**Status**: Implemented (2026-08-17)

## Context

A review of the compaction plugin found critical string-escaping bugs and a missing fragment integration that caused inconsistent token counting:

1. **Escaped newlines** (`\\n` instead of `\n`) throughout `SUMMARY_PREFIX`, `formatTurnsForSummary`, the summary prompts, and `handleDrop`'s regex — the summarizer transcript and prompts were malformed.
2. **Broken regex** in `handleDrop` (`/^\\d+$/` → `/^\d+$/`), so `drop N` never matched.
3. **`startIndex` parameter** to `formatTurnsForSummary` had been dropped, mislabeling slice turns.
4. **Fragment integration** — compaction computed context usage from only the base system prompt, ignoring registered prompt fragments, so its usage estimate diverged from the real context-window accounting.

## Decision

- **Restore `startIndex`** to `formatTurnsForSummary` (default 0) so slice turns are numbered relative to their position in the non-summary turn sequence.
- **Fix the `handleDrop` regex** to `/^\d+$/`.
- **Add `buildFragmentMessages`** to `CompactionPluginDeps` and `RegistrationContext` — an async callback that returns the rendered prompt-fragment system messages. Wired in `index.tsx` via `engine.renderPromptFragments()`. Used by `runCompaction` and `getStatus` so the context-window fallback and usage estimate account for fragment tokens consistently.
- **Use `calculateFallbackContextWindow`** in `getStatus` (was an inline formula).
- Fix the help-text typo `'Context Comp'` → `'Context Compaction'`.
- Restore JSDoc on `emitEvent` and `buildFragmentMessages`, plus algorithm-explaining comments (convergence loop, self-purge, slice-and-summarize, summary prepend/tail, failed summary).
- Fix `handleDrop` type safety (separate `const` per branch).

`buildFragmentMessages` remained **optional** (`deps.buildFragmentMessages ?? (async () => [])`) with a fallback, keeping the contract backward-compatible.

## Key Points

- Token counting for compaction's fallback context window and usage estimate now matches the real prompt-fragment accounting, so compaction's soft-threshold decision is accurate.
- The escaped-newline fixes produce well-formed summary transcripts and prompts.
- This is a correctness/consistency pass on the compaction plugin, complementary to the turn-granularity fix ([142-compaction-turn-granularity-fix](142-compaction-turn-granularity-fix.md)).

## Related

- session-management — Compaction triggering and context budgeting
- [134-compaction-correctness-fix](134-compaction-correctness-fix.md) — sliceSize + convergence loop
- [135-compaction-slash-command](135-compaction-slash-command.md) — `/compact` + extended capability
- [142-compaction-turn-granularity-fix](142-compaction-turn-granularity-fix.md) — Turn granularity fix
