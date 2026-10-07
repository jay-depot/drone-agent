---
tags: [decision, bug-fix, compaction, context-budget, safety-trim]
related: [concepts/session-management.md, modules/drone-agent.md, modules/drone-agent-plugins.md, flows/tool-call-loop.md, decisions/116-safety-trim-estimate-drop-mismatch.md, decisions/125-compaction-summary-eviction.md, decisions/053-compaction-latch-fix.md]
---

# 133. Compaction: Summarize Oldest Non-Summary Turns + Consolidate the "Oldest Non-Summary Turns" Helper

**Summary**: Fixed a regression where compaction summarized/dropped the **newest** non-summary turns instead of the **oldest**, and consolidated the "oldest non-summary turns, skipping summaries" rule into a single shared helper used by compaction, safety-trim, and session-manager. Removed the dead `dropOldestTurns` variant.

## Context

Compaction's slice-and-summarize logic in `plugins/compaction/index.ts` used `nonSummaryTurns.slice(-sliceSizeCapped)` — slicing the **tail** of the array. Because `appendUserMessage` pushes to the tail (newest last) while `prependSystemTurn` unshifts summaries to the head, the array was `[S_newest…S_oldest, normal_oldest…normal_newest]`. Slicing the tail therefore grabbed the **newest** normal turns, not the oldest. This regression was introduced in commit `c29bd93a` (the [125-compaction-summary-eviction](125-compaction-summary-eviction.md) fix, which switched from `slice(0, sliceSize)` to `slice(-sliceSizeCapped)`). *(Layout note: since [158-compaction-chronological-summary-block](158-compaction-chronological-summary-block.md) the array is `[S1…Sn chronological, normal_oldest…normal_newest]` — the tail-slicing bug analysis below remains historically accurate.)*

Separately, the safety-trim helper `getDroppableTurnPrefix` (introduced in [116-safety-trim-estimate-drop-mismatch](116-safety-trim-estimate-drop-mismatch.md)) had "stop at first summary turn" semantics that diverged from compaction's "skip summaries" intent. The two paths wanted the same thing — "oldest non-summary turns, skipping summaries" — but implemented it differently.

## Decision

Consolidate to **one** pure helper with "oldest non-summary turns, skipping summaries" semantics, used by all three paths (compaction, safety-trim estimate, and the actual drop). Remove the dead `dropOldestTurns` variant.

### 1. Rename + rework the helper: `getOldestNonSummaryTurns`

`runtime/turn-utils.ts` — renamed `getDroppableTurnPrefix` → `getOldestNonSummaryTurns(turns, count)`. It now iterates forward, **skips** (`continue`) summary turns instead of stopping at the first one, collects up to `count` non-summary turns in chronological order, returns fewer when insufficient, returns empty for `count <= 0`, and never mutates:

```typescript
export function getOldestNonSummaryTurns(
  turns: DroneSessionTurn[],
  count: number
): DroneSessionTurn[] {
  if (count <= 0) {
    return [];
  }
  const oldest: DroneSessionTurn[] = [];
  for (const turn of turns) {
    if (oldest.length >= count) {
      break;
    }
    if (turn.kind === 'summary') {
      continue;
    }
    oldest.push(turn);
  }
  return oldest;
}
```

### 2. `dropOldestNonSummaryTurns` selects via the helper, then drops by ID

`session-manager.ts` — `dropOldestNonSummaryTurns` now computes `toDrop = getOldestNonSummaryTurns(turns, count)` and drops those turns **by ID** via the shared `dropTurnsByIds` id-set logic (extracted into an internal `dropTurnsByIdsInternal` closure shared with the public `dropTurnsByIds`). This preserves head summaries — only the selected non-summary turns are removed, regardless of where they sit in the array. The dead `dropOldestTurns` method and its type signature were removed.

### 3. `evaluateSafetyTrim` uses the helper + filter-by-id

`context-budget-service.ts` — the leading-prefix loop now computes `droppable = getOldestNonSummaryTurns(input.turns, dropCount)` per drop count, breaks when `droppable.length < dropCount` (no more non-summary turns), and estimates the budget on `input.turns.filter(t => !droppableIds.has(t.id))` instead of `input.turns.slice(droppable.length)`. This keeps the predicted drop count aligned with what `dropOldestNonSummaryTurns` actually drops, guarding the non-convergence class from [116-safety-trim-estimate-drop-mismatch](116-safety-trim-estimate-drop-mismatch.md).

### 4. Compaction uses the helper

`plugins/compaction/index.ts` — replaced `nonSummaryTurns.slice(-sliceSizeCapped)` with `const slice = getOldestNonSummaryTurns(turns, sliceSize)`. The `startIndex` for `formatTurnsForSummary` is computed as `turns.filter(t => t.kind !== 'summary').length - slice.length` so the `--- Turn N ---` headers reflect the actual session turn numbers.

## Consequences

- Compaction now correctly targets the **oldest** non-summary turns, leaving the newest intact.
- Safety-trim and compaction share the exact same "skip summaries" drop semantics, so the estimate and the actual drop can never diverge.
- Head summaries are preserved by `dropOldestNonSummaryTurns` (previously it stopped at the first summary and dropped nothing after it).
- `dropOldestTurns` (dead code, no production callers) removed.

## Tests

- `turn-utils.test.ts` — rewritten for the new helper: skip summaries + continue past them, chronological order, `count <= 0`, insufficient non-summary turns, all-summaries → empty, non-mutating.
- `session-manager.test.ts` — `dropOldestNonSummaryTurns` now skips a head summary and drops the non-summary turns after it; summaries are preserved. Removed the `dropOldestTurns` tests.
- `context-budget-service.test.ts` — updated to skip-summaries semantics: a summary between non-summary turns is skipped (not counted as droppable); a head summary no longer returns `null` — the non-summary turns after it are counted as droppable.
- `compaction.test.ts` — added a regression test pinning **BOTH ends**: seeds `[S, u0..u5]` with distinct content, asserts the summary transcript contains the oldest (`u0`, `u1`) and NOT the newest (`u4`, `u5`), and that the surviving non-summary turns are the newest.

## Implementation

- **Commits**: `0ffb865` ("fix(compaction): summarize oldest non-summary turns, not newest"), `a430154` (chore: project memory + insights)
- **Files**: `drone-agent/src/runtime/turn-utils.ts`, `drone-agent/src/runtime/session-manager.ts`, `drone-agent/src/runtime/context-budget-service.ts`, `drone-agent/src/plugins/compaction/index.ts`, `drone-agent/test/turn-utils.test.ts`, `drone-agent/test/session-manager.test.ts`, `drone-agent/test/context-budget-service.test.ts`, `drone-agent/test/compaction.test.ts`
- **Validation**: LSP zero errors on all 8 touched files; `pnpm -r run build` clean; `pnpm typecheck` clean; prettier clean; full fast suite 1914 passed / 9 skipped (one flaky pre-existing coordinator broadcast test passed on re-run).

## Related

- session-management — Context budgeting, safety trim, and compaction
- [drone-agent](../../drone-agent/) — `turn-utils.ts`, `session-manager.ts`, `context-budget-service.ts`
- [drone-agent-plugins](../../drone-agent/src/plugins/) — The `compaction` plugin row
- tool-call-loop — The `ensureSafeBudget` loop that consumes the estimate
- [116-safety-trim-estimate-drop-mismatch](116-safety-trim-estimate-drop-mismatch.md) — Prior safety-trim estimate vs. actual drop fix (introduced the helper this decision renames)
- [125-compaction-summary-eviction](125-compaction-summary-eviction.md) — Prior compaction fix (introduced the `slice(-sliceSizeCapped)` regression this decision fixes)
- [053-compaction-latch-fix](053-compaction-latch-fix.md) — Prior compaction latch fix
