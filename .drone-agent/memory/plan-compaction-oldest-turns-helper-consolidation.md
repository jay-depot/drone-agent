---
key: plan-compaction-oldest-turns-helper-consolidation
tags:
  []
created: 2026-08-14T03:39:16.452Z
updated: 2026-08-17T00:08:17.052Z
---

# Plan: Fix compaction removing newest turns; consolidate "oldest non-summary turns" helper

## Summary

Compaction currently summarizes/drops the _newest_ non-summary turns instead of the _oldest_. Root cause in `drone-agent/src/plugins/compaction/index.ts` (~L198-205): `nonSummaryTurns.slice(-sliceSizeCapped)` slices the array tail. Because `appendUserMessage` pushes to the tail (newest last) while `prependSystemTurn` unshifts summaries to the head, the array is `[S_newest…S_oldest, normal_oldest…normal_newest]`, so slicing the tail grabs the newest normal turns. Regression introduced in commit c29bd93a.

Additionally, the safety-trim helper `getDroppableTurnPrefix` has "stop at first summary" semantics that diverge from compaction's "skip summaries" intent. We consolidate to ONE helper with "oldest non-summary turns, skipping summaries" semantics used by both paths, and remove the dead `dropOldestTurns` variant.

## Array-ordering facts (source of truth: session-manager.ts)

- `appendUserMessage` → `turns.push(...)` (newest at tail).
- `appendAssistantMessage`/`appendToolResult` → append to the last turn (no new turn).
- `prependSystemTurn` → `turns.unshift(...)` (newest summary at head).
- Combined: `[S_newest…S_oldest, normal_oldest…normal_newest]`.
- "Oldest non-summary turn" = first non-summary turn scanning from index 0, skipping any summary turns.

## Steps

1. turn-utils.ts — rename `getDroppableTurnPrefix` → `getOldestNonSummaryTurns(turns, count)`. Pure; iterate forward, skip `kind === 'summary'`, collect up to `count` non-summary turns in chronological order; return fewer when insufficient; empty for count <= 0; never mutate.
2. session-manager.ts — rework `dropOldestNonSummaryTurns` to select via the helper then drop BY ID (reuse `dropTurnsByIds` id-set logic), so head summaries are preserved. Remove `dropOldestTurns` method + its type signature.
3. context-budget-service.ts `evaluateSafetyTrim` — replace the leading-prefix loop: for each dropCount, `droppable = getOldestNonSummaryTurns(input.turns, dropCount)`; break if `droppable.length < dropCount`; remaining turns = `input.turns.filter(t => !idSet(droppable).has(t.id))`; evaluate budget on remaining. Keeps predicted drop count aligned with what `dropOldestNonSummaryTurns` actually drops (guards the non-convergence class at context-budget-service.test.ts:129).
4. compaction/index.ts — replace the slice logic with `const slice = getOldestNonSummaryTurns(turns, sliceSize)`; compute startIndex as `turns.filter(t => t.kind !== 'summary').length - slice.length` for `formatTurnsForSummary`. Import `getOldestNonSummaryTurns` from `../../runtime/turn-utils.js`.
5. Update tests:
   - turn-utils.test.ts: rewrite for new helper (skip summaries, order, count<=0, no mutation, insufficient).
   - session-manager.test.ts: update dropOldestNonSummaryTurns tests (summary at head now SKIPPED, non-summary after dropped; summaries preserved). Remove dropOldestTurns tests.
   - context-budget-service.test.ts: update expectations to skip-summaries semantics ("head is summary" no longer returns null; the 'between' test now treats all non-summary as droppable).
   - compaction.test.ts: add regression test pinning BOTH ends — seed distinct content (oldest-u0…newest-u5 + a seeded summary); assert summary transcript contains oldest and NOT newest; surviving non-summary turns are the newest.
6. Validation: LSP zero errors; `pnpm -r run lint` zero errors; `pnpm -r run build` zero errors; fast test suite passes.

## Files touched

- drone-agent/src/runtime/turn-utils.ts
- drone-agent/src/runtime/session-manager.ts
- drone-agent/src/runtime/context-budget-service.ts
- drone-agent/src/plugins/compaction/index.ts
- drone-agent/test/turn-utils.test.ts
- drone-agent/test/session-manager.test.ts
- drone-agent/test/context-budget-service.test.ts
- drone-agent/test/compaction.test.ts

## Notes

- No drone-core changes → no cross-package rebuild needed before typecheck, but run `pnpm -r run build` as part of validation anyway.
- `dropOldestTurns` has no production callers (only its own test) → remove as dead code.

---

## COMPLETED 2026-08-16 (commit 0ffb865 on fix/compaction-turn-ordering)

All steps executed and validated. Summary of what was done:

- **turn-utils.ts**: Renamed `getDroppableTurnPrefix` → `getOldestNonSummaryTurns(turns, count)`. Now iterates forward, `continue`s past `kind === 'summary'` turns, collects up to `count` non-summary turns in chronological order, returns fewer when insufficient, empty for count <= 0, never mutates.
- **session-manager.ts**: Extracted the drop-by-ids logic into an internal `dropTurnsByIdsInternal` function (shared by `dropTurnsByIds` and `dropOldestNonSummaryTurns`). `dropOldestNonSummaryTurns` now selects via `getOldestNonSummaryTurns` then drops by id, so head summaries are preserved. Removed the `dropOldestTurns` method and its type signature (dead code).
- **context-budget-service.ts**: `evaluateSafetyTrim` now uses `getOldestNonSummaryTurns` per dropCount and filters remaining turns by id-set (`input.turns.filter(t => !droppableIds.has(t.id))`) instead of `slice(droppable.length)`, keeping the predicted drop count aligned with what `dropOldestNonSummaryTurns` actually drops.
- **compaction/index.ts**: Replaced `nonSummaryTurns.slice(-sliceSizeCapped)` with `getOldestNonSummaryTurns(turns, sliceSize)`; startIndex computed as `turns.filter(t => t.kind !== 'summary').length - slice.length`.
- **Tests**: Rewrote turn-utils tests for the new helper (skip summaries, order, count<=0, no mutation, insufficient, all-summaries). Updated session-manager tests to skip-summaries semantics (head summary now skipped, non-summary after dropped; summaries preserved) and removed dropOldestTurns tests. Updated context-budget-service tests: the 'between' test now expects `requiredDropTurnCount: 2` (dropping a,b gets under budget; summary S is skipped, not counted); the 'head is summary' test now expects `requiredDropTurnCount: 1` (dropping 'a' gets under budget) instead of null. Added a compaction regression test pinning BOTH ends: seeds `[S, u0..u5]`, asserts the summary transcript contains oldest (u0,u1) and NOT newest (u4,u5), and surviving non-summary turns are the newest.
- **Validation**: LSP zero errors on all 8 touched files; `pnpm -r run build` passes; `pnpm typecheck` passes; prettier clean; full fast test suite passes (1914 passed, 9 skipped). One flaky pre-existing failure in `drone-coordinator/test/routes/messages.test.ts` (message broadcast) passed on re-run in isolation and on the second full-suite run — unrelated to these changes.

### Notes / deviations
- The plan's step-3 note referenced "context-budget-service.test.ts:129" for the non-convergence guard; that test was updated to reflect the new skip-summaries semantics (no longer returns null for a head summary).
- The plan's step-5 context-budget-service test expectations were refined during implementation based on actual token math (maxPromptTokens 400; each 800-char turn ≈ 206 tokens; summary ≈ 7 tokens): the 'between' test needs 2 drops, the 'head summary' test needs 1 drop.
- eslint config ignores `drone-agent/src/**` and `**/test/**/*.ts`, so eslint reports no errors on these files; prettier formatting was verified separately and is clean.