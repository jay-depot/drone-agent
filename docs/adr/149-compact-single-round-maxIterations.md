---
tags: [decision, compaction, slash-command, bugfix]
related: [concepts/session-management.md, modules/drone-agent-plugins.md, decisions/134-compaction-correctness-fix.md, decisions/135-compaction-slash-command.md, decisions/148-compact-manual-force-skips-threshold.md]
---

# 149: `/compact` performs exactly one forced round via `maxIterations`

**Status**: Implemented (2026-08-21)

## Context

After commit `2abaaf34` ("fix(compaction): /compact now forces compaction below the soft threshold", decision [148-compact-manual-force-skips-threshold](148-compact-manual-force-skips-threshold.md)), `maybeCompact`'s early-bail changed from `if (metrics.usagePercent <= softThreshold) break;` to `if (!input.options.force && metrics.usagePercent <= softThreshold) break;`.

That `force` fix was correct, but it had an unintended side effect: because `force` now bypasses the threshold bail, **both** manual paths (`/compact` → `forceEvaluate`, `/compact --all` → `forceEvaluateAll`) began running the **full convergence loop** (`MAX_COMPACTION_ITERATIONS = 5`), slicing-and-summarizing until every non-summary turn was consumed.

`/compact --all` was unaffected — it passes `slicePercentOverride: 100`, so `desiredSlice = nonSummaryCount` and a single round already compacts everything.

But plain `/compact` now **over-compacted**: it looped through every slice until no non-summary turns remained, rather than stopping after one forced slice. Any still-over-threshold remainder should be left for automatic compaction (the `onBeforePrompt` / `onAfterToolCall` hooks) on subsequent fires — not eagerly consumed by a single manual `/compact`.

## Decision

Generalize `CompactionOptions` (in `drone-agent/src/plugins/compaction/index.ts`) with a `maxIterations?: number` option that caps the number of slice-and-summarize rounds in a single `maybeCompact` call:

- **Automatic hooks** (`hookBody` for `onBeforePrompt` / `onAfterToolCall`) omit it → the loop bound stays `MAX_COMPACTION_ITERATIONS = 5` (convergence-loop behavior preserved).
- **`forceEvaluate`** passes `{ force: true, maxIterations: 1 }` → plain `/compact` performs exactly **one** forced slice.
- **`forceEvaluateAll`** passes `{ force: true, slicePercentOverride: 100, maxIterations: 1 }` → behaviorally identical to today (one round already compacts everything with `slicePercentOverride: 100`), but the explicit cap makes intent clear.

In `maybeCompact`, the loop bound becomes `input.options.maxIterations ?? MAX_COMPACTION_ITERATIONS`:

```ts
const maxIterations = input.options.maxIterations ?? MAX_COMPACTION_ITERATIONS;
for (let iteration = 0; iteration < maxIterations; iteration++) { ... }
```

### Corner intentionally left as-is

If the single allowed iteration lands on the **self-purge branch** (summary region over budget), `/compact` self-purges one summary and does **not** slice. Accepted — rare, legitimate single action.

## Consequences

- Plain `/compact` compacts exactly one forced slice and stops, even when non-summary turns remain above the soft threshold. The remainder is left for automatic compaction on subsequent fires.
- `/compact --all` behavior is unchanged.
- Automatic (non-force) compaction retains the 5-iteration convergence loop.

## Tests

- Updated `"exposes a forceEvaluate capability that triggers compaction"`: now expects `provider.__chatMock` called exactly **1** time, `sessionManager.getSummaryTurns()` length **1**, and non-summary turns remaining `> 0` (previously expected 3 chat calls converging to 2 summaries with the full loop).
- Added a new regression test `"compacts via /compact exactly one full round"`: seeds many non-summary turns above threshold, runs plain `/compact`, asserts `provider.__chatMock` called exactly once and non-summary turns remain afterward (i.e. it did **NOT** converge to zero).
- Verified the pre-existing convergence-loop tests (automatic path) still cap at 5, and all pre-existing `/compact` + `/compact --all` slash-command tests are unchanged.

## Implementation

- **Commit**: `b307c23` ("fix(compaction): /compact performs exactly one forced round via maxIterations")
- **Files**: `drone-agent/src/plugins/compaction/index.ts`, `drone-agent/test/compaction.test.ts`
- **Validation**: LSP clean; `pnpm build` clean; `pnpm typecheck` clean; root `pnpm lint` clean (`pnpm -r run lint` is unavailable — no package defines a `lint` script); `pnpm test` 1989 passed / 9 skipped; `drone-agent/test/compaction.test.ts` 43 tests passed.

## Related

- session-management — Turn model + compaction triggering + manual `/compact`
- [drone-agent-plugins](../../drone-agent/src/plugins/) — The `compaction` plugin row
- [148-compact-manual-force-skips-threshold](148-compact-manual-force-skips-threshold.md) — The prior fix that made `force` skip the threshold gate and, unintentionally, run the full convergence loop
- [135-compaction-slash-command](135-compaction-slash-command.md) — The `/compact` command + `CompactionCapability`
- [134-compaction-correctness-fix](134-compaction-correctness-fix.md) — Convergence loop + `sliceSize`