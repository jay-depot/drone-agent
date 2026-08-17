---
key: plan-compaction-correctness-fix
tags:
  - compaction
  - bugfix
  - plan
created: 2026-08-17T01:44:40.204Z
updated: 2026-08-17T02:10:00.000Z
---

# Plan: Compaction Correctness Fix

## Summary

The compaction plugin has five correctness bugs that together cause context usage to spiral upward despite compaction being active. The primary bug is that `sliceSize` is computed against `turns.length` (which includes summaries), causing compaction to progressively weaken as summaries accumulate — a death spiral. Secondary bugs include a misleading comment, backwards turn numbering in the summary prompt, single-shot compaction (no convergence loop), and a race-prone assertion.

## Bugs

### Bug #1 (High): `sliceSize` computed against `turns.length` — includes summaries

`turns.length` includes summary turns. When `slicePercent=25` and the array is `[S1, S2, u0..u17]` (20 turns), `desiredSlice = floor(20 * 0.25) = 5`. But 2 of those 20 turns are summaries that can't be compacted, so only `5/18 = 28%` of the _actual_ conversation content gets compacted. As summaries accumulate, the fraction shrinks further — compaction falls behind and context usage climbs.

**Fix:** Compute `sliceSize` against the count of non-summary turns.

### Bug #2 (Low): Misleading comment about "end of the array"

The comment says oldest non-summary turns "live at the end of the array." They actually live immediately after the summary region. The newest non-summary turns live at the end.

**Fix:** Correct the comment.

### Bug #3 (Low): `startIndex` in `formatTurnsForSummary` is backwards

`formatTurnsForSummary(turns, startIndex)` numbers turns as `startIndex + index + 1`. The current `startIndex = nonSummaryCount - slice.length` labels the oldest turns with high numbers (as if they're near the end of the conversation). This is a cosmetic lie to the LLM summarizer.

**Fix:** Remove the `startIndex` parameter entirely. Number slice turns as Turn 1, Turn 2, ... — the summarizer doesn't need absolute position.

### Bug #4 (Medium): `maybeCompact` is single-shot — no convergence loop

`maybeCompact` either drops one summary or compacts one slice per invocation. If usage is still above threshold after one round, nothing happens until the next hook fire. With Bug #1, this compounds: compaction takes progressively smaller slices while summaries accumulate.

**Fix:** Add a convergence loop in `maybeCompact` that keeps dropping summaries and/or compacting slices until usage is below the soft threshold (or no more progress can be made).

### Bug #5 (Low): `dropTurnsByIds` assertion is race-prone

The assertion `if (dropped.length !== slice.length) throw ...` will throw if anything mutates the session between `getTurns()` (snapshot) and `dropTurnsByIds` (mutation). The `compactionInFlight` guard should prevent this, but a defensive warning is safer than an exception that abandons the entire compaction round.

**Fix:** Replace the hard throw with a `logger.warn` and continue (the compaction still succeeds for whatever turns were actually dropped).

## Step-by-step implementation

### Step 1: Fix `formatTurnsForSummary` — remove `startIndex` parameter

**File:** `drone-agent/src/plugins/compaction/index.ts`

Change the function signature from:

```ts
function formatTurnsForSummary(
  turns: DroneSessionTurn[],
  startIndex = 0
): string {
```

to:

```ts
function formatTurnsForSummary(turns: DroneSessionTurn[]): string {
```

Change the template string from:

```ts
return `--- Turn ${startIndex + index + 1} ---\n${parts.join('\n')}`;
```

to:

```ts
return `--- Turn ${index + 1} ---\n${parts.join('\n')}`;
```

Update the call site from:

```ts
const transcript = formatTurnsForSummary(
  slice,
  turns.filter(turn => turn.kind !== 'summary').length - slice.length
);
```

to:

```ts
const transcript = formatTurnsForSummary(slice);
```

### Step 2: Fix `sliceSize` computation — use non-summary count

**File:** `drone-agent/src/plugins/compaction/index.ts`

Replace:

```ts
const desiredSlice = Math.floor((turns.length * config.slicePercent) / 100);
const sliceSize = Math.max(
  config.minTurnsToCompact,
  Math.min(desiredSlice, turns.length - 1)
);
```

With:

```ts
const nonSummaryCount = turns.filter(turn => turn.kind !== 'summary').length;
const desiredSlice = Math.floor((nonSummaryCount * config.slicePercent) / 100);
const sliceSize = Math.max(
  config.minTurnsToCompact,
  Math.min(desiredSlice, nonSummaryCount)
);
```

Also add a guard: if `nonSummaryCount < config.minTurnsToCompact`, bail out of compaction (not enough non-summary turns to slice). The `Math.max(minTurnsToCompact, ...)` already handles this implicitly via `sliceSize <= 0` check below, but it's cleaner to be explicit.

### Step 3: Fix the misleading comment

**File:** `drone-agent/src/plugins/compaction/index.ts`

Replace:

```ts
// Normal turns age toward the tail; summaries are prepended at the head.
// Compaction must target the oldest non-summary turns, which live at the
// end of the array, not the head (where the newest summary sits).
```

With:

```ts
// Summaries are prepended at the head; normal turns are appended at the tail.
// The oldest non-summary turns sit right after the summary region.
// getOldestNonSummaryTurns iterates forward, skipping summaries, to collect
// exactly these turns.
```

### Step 4: Add convergence loop in `maybeCompact`

**File:** `drone-agent/src/plugins/compaction/index.ts`

Refactor `maybeCompact` so that both the summary self-purge and the slice-and-summarize paths loop until usage is below the soft threshold or no more progress can be made.

Pseudocode for the new flow:

```
while usage > softThreshold:
  if summaryPercent > summaryBudget:
    drop oldest summary
    if no summary was dropped: break  // no progress possible
    recalculate metrics
    continue  // try again from the top

  if nonSummaryCount < minTurnsToCompact: break  // not enough to compact

  compute sliceSize from nonSummaryCount
  get oldest non-summary turns for the slice
  call LLM to summarize
  drop turns by id (soften assertion to warning)
  prepend summary turn
  recalculate metrics
  // loop continues — if still above threshold, will compact again
```

Key implementation details:

- Recalculate `turns` and `metrics` at the top of each loop iteration (the session state changed).
- The `compactionInFlight` guard is already set by the caller and cleared after `maybeCompact` returns — the loop is internal, so this is fine.
- Each LLM call for summarization is awaited; this means the loop may take multiple round-trips but guarantees convergence.
- The loop must have a hard cap (e.g., max 5 iterations per `maybeCompact` call) to prevent infinite loops if summarization keeps producing summaries that are too large.

### Step 5: Soften `dropTurnsByIds` assertion to warning

**File:** `drone-agent/src/plugins/compaction/index.ts`

Replace:

```ts
const dropped = sessionManager.dropTurnsByIds(slice.map(t => t.id));
if (dropped.length !== slice.length) {
  throw new Error('Failed to drop the intended turns for summarization.');
}
```

With:

```ts
const dropped = sessionManager.dropTurnsByIds(slice.map(t => t.id));
if (dropped.length !== slice.length) {
  logger.warn(
    `compaction: expected to drop ${slice.length} turns but dropped ${dropped.length}; proceeding with partial drop`
  );
}
```

This is defensive: if fewer turns were dropped than expected (due to a concurrent mutation), we still have a valid summary and some turns were removed. The loop in Step 4 will recalculate and continue if still over threshold.

### Step 6: Update tests

**File:** `drone-agent/test/compaction.test.ts`

- **Update the "pins BOTH ends" test** to remove any assertion on `startIndex` / turn numbering, since `formatTurnsForSummary` no longer uses it.
- **Add a test for convergence loop**: seed a session with enough turns to require multiple compaction rounds in a single `maybeCompact` call. Verify that after the call, usage is below the soft threshold.
- **Add a test for the death spiral fix**: seed a session with summaries already present, verify that `sliceSize` is computed against non-summary count (not total count). E.g., 2 summaries + 8 normal turns, `slicePercent=50` should compact 4 turns (50% of 8), not 5 (25% of 10 then capped).
- **Add a test for max iteration cap**: seed a session where each compaction round only removes a tiny fraction (e.g., `minTurnsToCompact=1`, very small context window). Verify that `maybeCompact` terminates after a bounded number of iterations, not infinitely.

**File:** `drone-agent/test/turn-utils.test.ts`

- No changes needed — `getOldestNonSummaryTurns` and its tests are already correct.

**File:** `drone-agent/test/session-manager.test.ts`

- No changes needed — `dropOldestNonSummaryTurns` and `dropTurnsByIds` tests are already correct.

**File:** `drone-agent/test/context-budget-service.test.ts`

- No changes needed — the `evaluateSafetyTrim` tests already exercise the correct `getOldestNonSummaryTurns` path.

### Step 7: Lint, build, and test

Run the full validation pipeline:

1. `pnpm -r run build` — ensure all packages compile
2. `pnpm -r run lint` — zero errors (prettier will auto-format)
3. LSP diagnostics — zero errors in changed files
4. `pnpm -r run test` — all fast tests pass
5. Re-read any files that prettier reformatted before final review

## Validation criteria

- [ ] All LSP diagnostics in changed files are clean (zero errors, zero warnings in drone-agent/src and drone-agent/test)
- [ ] `pnpm -r run build` passes with zero errors
- [ ] `pnpm -r run lint` passes with zero errors
- [ ] `pnpm -r run test` passes with zero failures
- [ ] `sliceSize` is computed against non-summary count, not total turns count
- [ ] `formatTurnsForSummary` has no `startIndex` parameter
- [ ] `maybeCompact` loops until usage is below soft threshold (with max iteration cap)
- [ ] `dropTurnsByIds` length mismatch logs a warning, not a throw
- [ ] The misleading comment about "end of the array" is corrected
- [ ] New tests cover: convergence loop, death spiral fix, max iteration cap

## Implementation summary (completed 2026-08-17)

All five bugs were fixed in `drone-agent/src/plugins/compaction/index.ts` and the
test suite was updated in `drone-agent/test/compaction.test.ts`.

### Changes made

1. **Bug #1 (sliceSize vs non-summary count):** `sliceSize` is now computed
   against `nonSummaryCount` (turns filtered to `kind !== 'summary'`) instead of
   `turns.length`. Added an explicit guard that bails out when
   `nonSummaryCount < config.minTurnsToCompact`.
2. **Bug #2 (misleading comment):** Replaced the "end of the array" comment with
   an accurate one describing that the oldest non-summary turns sit right after
   the summary region.
3. **Bug #3 (startIndex in formatTurnsForSummary):** Removed the `startIndex`
   parameter entirely; slice turns are now numbered Turn 1, Turn 2, ... The call
   site passes only the slice.
4. **Bug #4 (single-shot compaction):** `maybeCompact` now wraps both the
   self-purge and slice-and-summarize paths in a convergence loop
   (`MAX_COMPACTION_ITERATIONS = 5`). Each iteration recalculates metrics from
   the current session state. The loop breaks when usage is below the soft
   threshold, no progress is possible, or the iteration cap is hit.
5. **Bug #5 (race-prone assertion):** `dropTurnsByIds` length mismatch now logs
   a `logger.warn` and continues with the partial drop instead of throwing.

### Test updates

- Updated existing tests to reflect the convergence-loop behavior (multiple
  chat calls per `maybeCompact` invocation, summaries dropped until under
  budget, etc.).
- Added three new tests:
  - `converges to below the soft threshold in a single maybeCompact call`
  - `computes sliceSize against the non-summary turn count (death spiral fix)`
  - `caps the convergence loop at a bounded number of iterations`

### Validation

- LSP diagnostics: zero errors in changed files.
- `pnpm -r run build`: passes.
- `pnpm lint` (eslint + prettier): passes.
- `pnpm test`: 1917 passed, 9 skipped, 0 failures.
