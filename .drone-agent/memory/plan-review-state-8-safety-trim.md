---
key: plan-review-state-8-safety-trim
tags:
  - plan
  - review-state-8
  - safety-trim
  - context-budget
created: 2026-08-11T15:10:42.699Z
updated: 2026-08-11T15:10:42.699Z
---

# Plan: Fix safety-trim estimate vs. actual drop mismatch (review-state #8)

## Bug
`evaluateSafetyTrim` (drone-agent/src/runtime/context-budget-service.ts) computes requiredDropTurnCount via `input.turns.slice(dropCount)`, dropping turns from the front regardless of `kind` (incl. summary turns). But the actual drop (conversation-service.ts ensureSafeBudget) calls `sessionManager.dropOldestNonSummaryTurns`, which STOPS at the first summary turn. When oldest turns are summaries, the estimate overcounts droppable turns, the while(true) loop fails to converge, and it hard-fails with "no turns could be dropped" even though dropping would work.

## Approach (user chose Option B)
Extract drop logic into a single shared pure helper used by BOTH dropOldestNonSummaryTurns and evaluateSafetyTrim so estimate and actual drop can never diverge.

## Steps
1. NEW drone-agent/src/runtime/turn-utils.ts — export pure non-mutating `getDroppableTurnPrefix(turns, count)`: returns longest leading prefix of non-summary turns up to count, stopping before first summary turn.
2. session-manager.ts: `dropOldestNonSummaryTurns` delegates to helper (shift turns in toDrop out of internal array). Behavior identical; existing tests pass.
3. context-budget-service.ts `evaluateSafetyTrim`: loop dropCount 1..turns.length using getDroppableTurnPrefix; break when droppable.length < dropCount (hit summary); use droppable.length as requiredDropTurnCount; return null when all non-summary dropped still over budget.
4. Tests: NEW drone-agent/test/turn-utils.test.ts (prefix behavior, count<=0, stops at summary, non-mutating). Add evaluateSafetyTrim coverage to context-budget-service.test.ts (regression: summary head skipped, correct count, null when unfixable). Add optional config param to makeBudgetService (or large turns) to force requiresSafetyTrim deterministically.
5. Verify: typecheck, lint, build, test all pass; LSP zero diagnostics.

## Validation Criteria
1. turn-utils.ts exports getDroppableTurnPrefix (pure, non-mutating).
2. dropOldestNonSummaryTurns delegates to helper; existing session-manager tests pass unchanged.
3. evaluateSafetyTrim skips summary turns; new regression tests pass; no non-convergence when oldest turns are summaries.
4. All existing tests pass; new unit tests cover helper + safety-trim scenario.
5. LSP zero errors/warnings on touched files.
6. pnpm -r run typecheck / lint / build / test pass with zero errors.
7. No dead code, no unused imports, no leftover duplicate drop logic.

## Notes
- Place helper in src/runtime/ (runtime-specific, adjacent to both consumers), not src/shared/.
- Compaction plugin (src/plugins/compaction/index.ts:235) also calls dropOldestNonSummaryTurns — automatically benefits, no change needed.
