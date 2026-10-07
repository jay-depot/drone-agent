---
tags: [decision, compaction, bug-fix]
related: [concepts/session-management.md, modules/drone-agent-plugins.md, decisions/053-compaction-latch-fix.md, decisions/116-safety-trim-estimate-drop-mismatch.md, decisions/133-compaction-oldest-turns-helper-consolidation.md]
---

# 125. Compaction: Evict Oldest Summaries and Compact Oldest Non-Summary Turns

**Summary**: Fixed a bug in the compaction system where summaries were being dropped incorrectly during the compaction process. The fix ensures that (1) oldest summaries are evicted first when the summary count exceeds the limit, and (2) oldest non-summary turns are compacted when the turn count exceeds the limit.

> **Note (2026-08-16):** The `nonSummaryTurns.slice(-sliceSizeCapped)` approach introduced a regression — it sliced the array **tail**, which contains the **newest** non-summary turns (summaries are prepended at the head, normal turns appended at the tail). This was fixed in [133-compaction-oldest-turns-helper-consolidation](133-compaction-oldest-turns-helper-consolidation.md), which replaced the slice with the shared `getOldestNonSummaryTurns` helper.

## Context

The compaction plugin's summary management had two bugs:

1. **Summary eviction order was wrong.** `dropSummaryTurnById(summaryTurns[0].id)` dropped the *newest* summary (at the head of the array) instead of the *oldest* (at the tail). Since `prependSystemTurn` puts each new summary at the head, `getSummaryTurns()` is newest-first. The self-purge should drop the *oldest* summary, which is at the end of the array. *(Superseded by [158-compaction-chronological-summary-block](158-compaction-chronological-summary-block.md): storage is now chronological, `getSummaryTurns()` is oldest-first, and the self-purge drops `[0]` — same intent, simpler indexing.)*

2. **Compaction targeted the wrong turns.** `turns.slice(0, sliceSize)` took the *head* of the turns array, which contains the newest summary (prepended at the head). This meant compaction was re-summarizing the existing summary instead of the oldest non-summary turns. Normal turns age toward the tail; summaries are prepended at the head. Compaction must target the oldest non-summary turns, which live at the end of the array.

## Decision

### 1. Evict oldest summary first

Changed `dropSummaryTurnById(summaryTurns[0].id)` to `dropSummaryTurnById(summaryTurns.at(-1)!.id)` — the last element of `getSummaryTurns()` is the oldest summary. *(Superseded by [158-compaction-chronological-summary-block](158-compaction-chronological-summary-block.md): with chronological storage the drop target is `[0]` again.)*

### 2. Compact oldest non-summary turns

In `maybeCompact`:

```typescript
// Normal turns age toward the tail; summaries are prepended at the head.
// Compaction must target the oldest non-summary turns, which live at the
// end of the array, not the head (where the newest summary sits).
const nonSummaryTurns = turns.filter(turn => turn.kind !== 'summary');
const sliceSizeCapped = Math.min(sliceSize, nonSummaryTurns.length);
const slice = nonSummaryTurns.slice(-sliceSizeCapped);
const transcript = formatTurnsForSummary(
  slice,
  nonSummaryTurns.length - slice.length
);
```

### 3. New `dropTurnsByIds` on session manager

Added `dropTurnsByIds(ids: string[]): DroneSessionTurn[]` to the `DroneSessionManager` interface and implementation. This drops turns by their IDs, preserving order in the returned array. Used by compaction to drop exactly the turns that were summarized.

### 4. Turn numbering fix

`formatTurnsForSummary` now takes a `startIndex` parameter so the `--- Turn N ---` headers reflect the actual turn numbers in the session, not the slice-relative index.

## Consequences

- Compaction now correctly targets the oldest non-summary turns instead of re-summarizing existing summaries.
- The summary self-purge drops the oldest summary first, keeping the most recent summaries.
- `dropTurnsByIds` provides a precise way to drop exactly the turns that were summarized, with a consistency check (`dropped.length !== slice.length` throws).

## Tests

New tests added to `drone-agent/test/compaction.test.ts`:
- `compacts the oldest normal turns after a summary already exists`
- `continues to reduce context usage across multiple compaction rounds`
- `evicts the oldest summary first when summary budget is exceeded`

New tests added to `drone-agent/test/session-manager.test.ts`:
- `drops turns by id, preserving order in the returned array`
- `drops turns by id across mixed summary and normal turns`
- `returns an empty array when dropTurnsByIds receives no ids`

## Related

- session-management — Compaction is driven by the context budget service
- [drone-agent-plugins](../../drone-agent/src/plugins/) — The `compaction` plugin row
- [053-compaction-latch-fix](053-compaction-latch-fix.md) — Prior compaction latch fix
- [116-safety-trim-estimate-drop-mismatch](116-safety-trim-estimate-drop-mismatch.md) — Safety-trim estimate vs actual drop mismatch fix
