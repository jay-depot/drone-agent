---
id: compaction-summary-drop-fix
title: Compaction Plugin Summary Drop Fix
scope: beacon
tags: [compaction, summary, bug, session-manager, context-budget]
sources: [commit-5edaaef, memory-compaction-plugin-summary-drop-bug-plan-v2]
createdAt: 2026-08-13T22:25:00.000Z
updatedAt: 2026-08-13T22:25:00.000Z
---

# Compaction Plugin Summary Drop Fix

## Summary

Fixed a bug in the `drone-agent` context compaction plugin where old summaries were not being evicted correctly and, more importantly, compaction rounds stopped reducing context usage once the first summary was created. The plugin was effectively re-summarizing existing summaries instead of compacting older normal conversation turns.

## Root Causes

1. **Wrong summary eviction order**
   - `DroneSessionManager.prependSystemTurn()` uses `unshift()`, so summary turns live at the head of the turn array, newest-first.
   - The compaction self-purge path dropped `summaryTurns[0]`, which is the _newest_ summary, not the oldest. The log message claimed it was dropping the oldest summary.

2. **Wrong slice target for compaction**
   - Normal conversation turns age toward the _tail_ of the array because they are appended over time.
   - The slice-and-summarize logic used `turns.slice(0, sliceSize)`, taking turns from the head.
   - Before any summary existed, the head contained the oldest normal turns, so it happened to work.
   - After a summary was prepended to the head, the next compaction round would slice and re-summarize the most recent summary instead of the oldest normal turns.
   - `dropOldestNonSummaryTurns()` also starts from the head and stops at the first summary, so once a summary existed it could no longer drop normal turns.
   - Result: each new summary was prepended, growing the summary region and total context rather than shrinking it, which is why context usage did not meaningfully drop across compaction rounds.

## Changes Made

### `drone-agent/src/runtime/session-manager.ts`

- Added `dropTurnsByIds(ids: string[]): DroneSessionTurn[]` to the `DroneSessionManager` interface and implementation.
- The method removes turns matching the supplied IDs and returns them in their original order.

### `drone-agent/src/plugins/compaction/index.ts`

- **Self-purge fix**: now drops `summaryTurns.at(-1)` so the truly oldest summary is evicted when the summary budget is exceeded.
- **Slice target fix**: filter out summary turns and select the oldest non-summary turns from the _tail_ (`nonSummaryTurns.slice(-sliceSize)`), then drop them by ID and prepend the new summary.
- **Transcript numbering**: `formatTurnsForSummary` now accepts a `startIndex` so turn labels reflect the original session position.
- Log message corrected to report the actual number of compacted turns (`slice.length`).

### Tests

- `drone-agent/test/compaction.test.ts`
  - Updated the summary-budget test to expect oldest-summary eviction.
  - Added `compacts the oldest normal turns after a summary already exists`.
  - Added `continues to reduce context usage across multiple compaction rounds`.
  - Added `evicts the oldest summary first when summary budget is exceeded`.
- `drone-agent/test/session-manager.test.ts`
  - Added coverage for `dropTurnsByIds`, including mixed summary/normal turn arrays.

## Commit

- `5edaaef` — `fix(compaction): evict oldest summaries and compact oldest non-summary turns`

## Files Modified

- `drone-agent/src/runtime/session-manager.ts`
- `drone-agent/src/plugins/compaction/index.ts`
- `drone-agent/test/compaction.test.ts`
- `drone-agent/test/session-manager.test.ts`

## Completed Plan

The work followed the completed plan stored in project memory as `compaction-plugin-summary-drop-bug-plan-v2`. The plan identified the ordering bug, the slice-target bug, the need for a `dropTurnsByIds` session-manager method, and the required test updates. All steps were executed and the fix was committed.
