---
tags: [decision, bug-fix, context-budget, safety-trim]
related:
  [
    concepts/session-management.md,
    modules/drone-agent.md,
    flows/tool-call-loop.md,
    entities/Session.md,
    decisions/053-compaction-latch-fix.md,
    decisions/133-compaction-oldest-turns-helper-consolidation.md,
  ]
---

# 116. Safety-trim estimate vs. actual drop mismatch (review-state #8)

**Summary**: Fixed a divergence between the safety-trim **estimate** (`evaluateSafetyTrim`) and the **actual drop** (`dropOldestNonSummaryTurns`) that could cause `ensureSafeBudget`'s `while(true)` loop to fail to converge and hard-fail with "no turns could be dropped" even though dropping would work.

## Context

The conversation service's `ensureSafeBudget` (in `conversation-service.ts`) trims the session when it exceeds the safe context budget. It works in a loop:

1. Call `budgetService.evaluateSafetyTrim(...)` to get a `requiredDropTurnCount` — the minimum number of oldest turns to drop to get under budget.
2. Call `sessionManager.dropOldestNonSummaryTurns(turnsToDrop)` to actually drop them.
3. Re-evaluate; repeat until under budget or no turns remain.

The bug: `evaluateSafetyTrim` (in `context-budget-service.ts`) computed `requiredDropTurnCount` by slicing turns from the front **regardless of `kind`** — `input.turns.slice(dropCount)` — which includes **summary turns**. But `dropOldestNonSummaryTurns` (in `session-manager.ts`) **stops at the first summary turn** and refuses to drop it.

So the estimate could say "drop 3 turns" while the actual drop only removed fewer (or zero) non-summary turns. In a session where the oldest turns were summaries, the loop could iterate without converging and eventually throw "no turns could be dropped" — even though the estimate said dropping would work.

## Decision

Extract the "drop oldest non-summary turns, stop at first summary turn" rule into a **single shared pure helper** used by BOTH the estimate and the actual drop, so they can never diverge again.

> **Note (2026-08-16):** This helper was later renamed to `getOldestNonSummaryTurns` and its semantics changed from "stop at the first summary turn" to "skip summary turns and continue past them" when the compaction fix consolidated all three paths (compaction, safety-trim estimate, and the actual drop) onto it. See [133-compaction-oldest-turns-helper-consolidation](133-compaction-oldest-turns-helper-consolidation.md).

### New shared helper: `getDroppableTurnPrefix` (now `getOldestNonSummaryTurns`)

Added `drone-agent/src/runtime/turn-utils.ts`:

```typescript
export function getDroppableTurnPrefix(
  turns: DroneSessionTurn[],
  count: number
): DroneSessionTurn[] {
  if (count <= 0) {
    return [];
  }
  const dropped: DroneSessionTurn[] = [];
  for (const turn of turns) {
    if (dropped.length >= count || turn.kind === 'summary') {
      break;
    }
    dropped.push(turn);
  }
  return dropped;
}
```

Pure and non-mutating — it returns the longest leading prefix of non-summary turns up to `count`, stopping before the first summary turn.

### `dropOldestNonSummaryTurns` delegates to the helper

`session-manager.ts` now computes the prefix via `getDroppableTurnPrefix(turns, count)` and shifts those turns out of the internal array. Behavior is identical to before.

### `evaluateSafetyTrim` uses the helper

`context-budget-service.ts` now iterates `dropCount` from 1..`turns.length`, computing `droppable = getDroppableTurnPrefix(input.turns, dropCount)`:

- If `droppable.length < dropCount`, it hit the first summary turn — no more non-summary turns are droppable, so it **breaks** (dropping more cannot help).
- Otherwise it estimates the budget with `input.turns.slice(droppable.length)` and, if under budget, returns `{ requiresTrim: true, requiredDropTurnCount: droppable.length }`.
- If the loop completes without finding a fit, it returns `null` (all non-summary turns dropped still exceed budget) — which `ensureSafeBudget` turns into its existing clear "no turns could be dropped" error.

## Consequences

- The estimate and the actual drop now share the exact same drop semantics, so `ensureSafeBudget` converges: when the oldest turns are summaries, the estimate correctly reports `null` (or a count that `dropOldestNonSummaryTurns` can actually satisfy) instead of overcounting.
- The compaction plugin benefits automatically — it also calls `dropOldestNonSummaryTurns` (see [053-compaction-latch-fix](053-compaction-latch-fix.md)), and now shares the same helper.
- No behavior change to `dropOldestNonSummaryTurns` itself — the refactor is behavior-preserving for the actual drop.

## Tests

- New `drone-agent/test/turn-utils.test.ts` (5 tests): prefix behavior, count ≤ 0, stops at summary, head-summary → empty, non-mutating.
- Added `evaluateSafetyTrim` regression coverage to `context-budget-service.test.ts` (4 tests): budget fits → no trim; summary-between → counts only non-summary turns; head-summary → `null` (no non-convergence); all non-summary dropped still over budget → `null`. Added an optional `config` param to `makeBudgetService` to force `requiresSafetyTrim` deterministically.

## Implementation

- **Commits**: `2306104` ("fix: safety-trim estimate vs actual drop mismatch (review-state #8)"), plus memory commits `420b690` (plan + review-state memory)
- **Files**: `drone-agent/src/runtime/turn-utils.ts` (new), `drone-agent/src/runtime/session-manager.ts`, `drone-agent/src/runtime/context-budget-service.ts`, `drone-agent/test/turn-utils.test.ts` (new), `drone-agent/test/context-budget-service.test.ts`
- **Validation**: `pnpm -r run typecheck`, `pnpm lint`, `pnpm -r run build` all clean; `pnpm test` 1804 passed / 9 skipped; LSP clean on all touched files.

## Related

- session-management — Context budgeting and safety trim
- [drone-agent](../../drone-agent/) — `context-budget-service.ts` and `session-manager.ts`
- tool-call-loop — The `ensureSafeBudget` loop that consumes the estimate
- [Session](../../drone-core/src/session-types.ts) — `DroneSessionTurn` with the `kind?: 'summary'` field
- [053-compaction-latch-fix](053-compaction-latch-fix.md) — Compaction, which shares `dropOldestNonSummaryTurns`
