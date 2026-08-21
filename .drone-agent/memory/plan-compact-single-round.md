---
key: plan-compact-single-round
tags:
  []
created: 2026-08-19T03:27:52.501Z
updated: 2026-08-19T03:27:52.501Z
---

# Plan: /compact performs exactly one forced round

## Summary

After commit 2abaaf34 ("fix(compaction): /compact now forces compaction below the soft threshold"), the `maybeCompact` early-bail was changed from `if (metrics.usagePercent <= softThreshold) break;` to `if (!input.options.force && metrics.usagePercent <= softThreshold) break;`. Because the `force` option now bypasses the threshold bail, BOTH manual paths (`/compact` → forceEvaluate, and `/compact --all` → forceEvaluateAll) now run the FULL convergence loop (MAX_COMPACTION_ITERATIONS = 5), slicing-and-summarizing until every non-summary turn is consumed.

`/compact --all` is unaffected: it passes `slicePercentOverride: 100`, so `desiredSlice = nonSummaryCount` and a single round already compacts everything.

But plain `/compact` now over-compacts, looping through every slice until no non-summary turns remain. It must stop after exactly one forced slice. Any still-over-threshold remainder is left for automatic compaction (onBeforePrompt / onAfterToolCall hooks) on subsequent fires.

## Design
Generalize `CompactionOptions` (drone-agent/src/plugins/compaction/index.ts) with `maxIterations?: number`:

- Automatic hooks (`hookBody` for onBeforePrompt/onAfterToolCall) omit it -> loop bound stays MAX_COMPACTION_ITERATIONS = 5 (convergence loop behavior preserved).
- `forceEvaluate` passes `{ force: true, maxIterations: 1 }`.
- `forceEvaluateAll` passes `{ force: true, slicePercentOverride: 100, maxIterations: 1 }` (behaviorally identical today; made explicit).
- In `maybeCompact`, the loop bound becomes `input.options.maxIterations ?? MAX_COMPACTION_ITERATIONS`.

Corner that is intentionally left as-is: if the single allowed iteration lands on the self-purge branch (summary region over budget), /compact self-purges one summary and does NOT slice. Accepted — rare, legitimate single action.

## Steps

### Step 1 — Add maxIterations option + cap the convergence loop
File: drone-agent/src/plugins/compaction/index.ts
- Extend `type CompactionOptions` with `maxIterations?: number;`
- In `maybeCompact`, replace the fixed `iteration < MAX_COMPACTION_ITERATIONS` bound with `iteration < (input.options.maxIterations ?? MAX_COMPACTION_ITERATIONS)`.
- `forceEvaluate` (inside createCompactionPlugin capability): pass `{ force: true, maxIterations: 1 }`.
- `forceEvaluateAll`: pass `{ force: true, slicePercentOverride: 100, maxIterations: 1 }`.
Dependency: none. Agent: coder.

### Step 2 — Update existing forceEvaluate test + add regression test
File: drone-agent/test/compaction.test.ts
- Update test "exposes a forceEvaluate capability that triggers compaction" (currently expects provider.__chatMock called 3 times with 10 non-summary turns and 2 summaries). Now forceEvaluate caps at 1 → expect provider.__chatMock toHaveBeenCalledTimes(1), sessionManager.getSummaryTurns() toHaveLength(1), and non-summary turns remaining > 0.
- Add new regression test: "/compact performs exactly one round" — seed many non-summary turns above threshold, run plain /compact, assert provider.__chatMock.toHaveBeenCalledTimes(1) and that non-summary turns remain afterward (i.e. it did NOT converge to zero).
- Verify existing tests still hold: /compact (called >0, summary created), /compact --all (exactly 1 call, 0 non-summary remaining), below-threshold /compact regression, and all convergence-loop tests (which use runBeforePrompt / automatic hooks and must still cap at 5).
Dependency: Step 1. Agent: coder.

### Step 3 — Verification
Run (from repo root):
- pnpm build
- pnpm typecheck
- pnpm lint (eslint + prettier)
- pnpm test (fast suite) — specifically drone-agent/test/compaction.test.ts
All must pass with zero failures. No dead code / unused vars; new behavior covered by unit tests.
Dependency: Steps 1-2. Agent: tester.

## Validation criteria
- drone-agent/test/compaction.test.ts passes 0 failures, including:
  - updated forceEvaluate test expecting exactly 1 chat call + remaining non-summary turns
  - new "/compact performs exactly one full round" regression test
  - all pre-existing convergence-loop tests (automatic path still caps at 5)
  - all pre-existing /compact + /compact --all slash command tests unchanged
- pnpm typecheck passes (LSP + tsc clean).
- pnpm -r run lint passes (eslint + prettier) — if the tools accept it; otherwise root `pnpm lint`. No eslint errors.
- pnpm -r run build passes.
- pnpm test passes.
- No dead code, no unused variables; comments only where they explain a non-obvious process (the maxIterations intent).