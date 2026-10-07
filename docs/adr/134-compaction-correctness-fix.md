---
tags: [decision, bug-fix, compaction, context-budget]
related: [concepts/session-management.md, modules/drone-agent-plugins.md, decisions/053-compaction-latch-fix.md, decisions/125-compaction-summary-eviction.md, decisions/133-compaction-oldest-turns-helper-consolidation.md, decisions/135-compaction-slash-command.md]
---

# 134. Compaction Correctness Fix: sliceSize, Convergence Loop, and Turn Numbering

**Summary**: Fixed five correctness bugs in the compaction plugin that together caused context usage to spiral upward despite compaction being active. The primary bug was `sliceSize` computed against `turns.length` (which includes summaries), causing compaction to progressively weaken as summaries accumulate — a death spiral. Also added a convergence loop so `maybeCompact` keeps compacting until usage is below the soft threshold, and removed the backwards turn numbering in the summary prompt.

## Context

The compaction plugin (`plugins/compaction/index.ts`) had five correctness bugs:

1. **Bug #1 (High): `sliceSize` computed against `turns.length` — includes summaries.** `turns.length` includes summary turns. When `slicePercent=25` and the array is `[S1, S2, u0..u17]` (20 turns), `desiredSlice = floor(20 * 0.25) = 5`. But 2 of those 20 turns are summaries that can't be compacted, so only `5/18 = 28%` of the *actual* conversation content gets compacted. As summaries accumulate, the fraction shrinks further — compaction falls behind and context usage climbs.

2. **Bug #2 (Low): Misleading comment about "end of the array."** The comment said oldest non-summary turns "live at the end of the array." They actually live immediately after the summary region. The newest non-summary turns live at the end.

3. **Bug #3 (Low): `startIndex` in `formatTurnsForSummary` is backwards.** `formatTurnsForSummary(turns, startIndex)` numbered turns as `startIndex + index + 1`. The `startIndex = nonSummaryCount - slice.length` labeled the oldest turns with high numbers (as if they're near the end of the conversation) — a cosmetic lie to the LLM summarizer.

4. **Bug #4 (Medium): `maybeCompact` is single-shot — no convergence loop.** `maybeCompact` either dropped one summary or compacted one slice per invocation. If usage was still above threshold after one round, nothing happened until the next hook fire. With Bug #1, this compounded: compaction took progressively smaller slices while summaries accumulated.

5. **Bug #5 (Low): `dropTurnsByIds` assertion is race-prone.** The assertion `if (dropped.length !== slice.length) throw ...` would throw if anything mutated the session between `getTurns()` (snapshot) and `dropTurnsByIds` (mutation). The `compactionInFlight` guard should prevent this, but a defensive warning is safer than an exception that abandons the entire compaction round.

## Decision

### 1. Fix `sliceSize` computation — use non-summary count

`sliceSize` is now computed against `nonSummaryCount` (turns filtered to `kind !== 'summary'`) instead of `turns.length`. Added an explicit guard that bails out when `nonSummaryCount < config.minTurnsToCompact`.

### 2. Correct the misleading comment

Replaced the "end of the array" comment with an accurate one describing that the oldest non-summary turns sit right after the summary region.

### 3. Remove `startIndex` from `formatTurnsForSummary`

Removed the `startIndex` parameter entirely; slice turns are now numbered Turn 1, Turn 2, ... The call site passes only the slice.

### 4. Add a convergence loop in `maybeCompact`

`maybeCompact` now wraps both the self-purge and slice-and-summarize paths in a convergence loop (`MAX_COMPACTION_ITERATIONS = 5`). Each iteration recalculates metrics from the current session state (since compaction mutates the session). The loop breaks when usage is below the soft threshold, no progress is possible, or the iteration cap is hit.

### 5. Soften `dropTurnsByIds` assertion to warning

`dropTurnsByIds` length mismatch now logs a `logger.warn` and continues with the partial drop instead of throwing.

## Consequences

- Compaction now correctly targets the oldest non-summary turns based on the actual conversation content, not the total turn count including summaries.
- The convergence loop guarantees compaction keeps working within a single `maybeCompact` call until usage is below the soft threshold (or no more progress can be made), rather than waiting for the next hook fire.
- The summary prompt no longer misleads the LLM with backwards turn numbering.
- A race in `dropTurnsByIds` no longer abandons the entire compaction round.

## Tests

- Updated existing tests to reflect the convergence-loop behavior (multiple chat calls per `maybeCompact` invocation, summaries dropped until under budget, etc.).
- Added three new tests:
  - `converges to below the soft threshold in a single maybeCompact call`
  - `computes sliceSize against the non-summary turn count (death spiral fix)`
  - `caps the convergence loop at a bounded number of iterations`

## Implementation

- **Commits**: `95817ad` ("fix(compaction): correct sliceSize, convergence loop, and turn numbering"), `bdd02ec` (chore checkpoint)
- **Files**: `drone-agent/src/plugins/compaction/index.ts`, `drone-agent/test/compaction.test.ts`
- **Validation**: LSP zero errors; `pnpm -r run build` clean; `pnpm lint` clean; `pnpm test` 1917 passed / 9 skipped.

## Related

- [[concepts/session-management]] — Context budgeting, safety trim, and compaction
- [[modules/drone-agent-plugins]] — The `compaction` plugin row
- [[decisions/053-compaction-latch-fix]] — Prior compaction latch fix
- [[decisions/125-compaction-summary-eviction]] — Prior compaction summary eviction fix
- [[decisions/133-compaction-oldest-turns-helper-consolidation]] — Prior oldest-turns fix + helper consolidation
- [[decisions/135-compaction-slash-command]] — The `/compact` slash command built on top of this fix
