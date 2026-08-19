---
key: plan-compact-manual-force
tags:
  - compaction
  - plan
  - slash-command
  - bugfix
created: 2026-08-19T01:56:06.000Z
updated: 2026-08-19T02:05:08.295Z
---

# Plan: `/compact` doesn't actually compact — manual force path gated by threshold

## Summary

The `/compact` slash command prints success messages ("Compacted oldest non-summary turns") but does not actually compact a session whose context usage is at or below the soft threshold. Manual compaction must force a compaction regardless of current usage; automatic compaction keeps the threshold gate.

## Root cause

In `drone-agent/src/plugins/compaction/index.ts`, `maybeCompact`'s convergence loop starts with:

```ts
const metrics = summarizeTokenCounts({ ... });

if (metrics.usagePercent <= softThreshold) {
  break;  // ← early exit before any compaction
}
```

This gate is correct for **automatic** compaction (don't summarize when already under budget), which is why automatic compaction works. But manual `/compact` calls `forceEvaluate`/`forceEvaluateAll` which pass `force: true` — and `force` only bypasses the `config.enabled` check, NOT this threshold gate. So on a session at/below threshold:

1. `handleCompact` → `cap.forceEvaluate()`
2. `maybeCompact` computes usage, sees `<= softThreshold`, and `break`s immediately — zero turns compacted
3. `handleCompact` then unconditionally prints "Compacted oldest non-summary turns"

The existing `/compact` tests pass because they set `softThresholdPercent: 5` with huge turns that push usage ABOVE the threshold, so the gate never fires.

## Fix

### `drone-agent/src/plugins/compaction/index.ts`

In the convergence loop, skip the threshold gate when `force` is set:

```ts
// BEFORE:
if (metrics.usagePercent <= softThreshold) {
  break;
}

// AFTER:
if (!input.options.force && metrics.usagePercent <= softThreshold) {
  break;
}
```

- `force: true` → skips the gate and proceeds to slice-and-summarize, so `/compact` actually compacts.
- Automatic (non-force) → gate unchanged.

## Regression test

Add to `drone-agent/test/compaction.test.ts` in the `/compact slash command` describe block:

- A `/compact` on a session whose usage is **below** the soft threshold must still call `provider.chat()` and produce at least one summary turn.
- This reproduces the exact bug: currently it would `break` early and produce zero summaries.

## Validation

- LSP passes (typescript) with zero errors on `compaction/index.ts` and `compaction.test.ts`.
- `pnpm -r run build`, `pnpm -r run typecheck`, `pnpm lint` pass.
- `pnpm test` — the new regression test passes (and fails without the fix); all existing compaction tests still pass.

## Scope notes

- Automatic compaction behavior is unchanged (`!input.options.force` guard preserves it).
- `/compact --all` (forceEvaluateAll) also benefits — same latent issue when usage is below threshold.
- The "Compacted…" success message is still printed unconditionally; making it reflect actual turns dropped is a separate minor hardening, out of scope for this fix.

## Status — COMPLETE (executed 2026-08-19)

Implemented and validated on branch `fix/compact-manual-force`.

### What was done
- **Fix** (`drone-agent/src/plugins/compaction/index.ts` line ~207): changed the convergence-loop gate from `if (metrics.usagePercent <= softThreshold) break;` to `if (!input.options.force && metrics.usagePercent <= softThreshold) break;`. Manual `/compact` (force) now proceeds to slice-and-summarize regardless of current usage; automatic compaction keeps the gate.
- **Regression test** (`drone-agent/test/compaction.test.ts`, `/compact slash command` block): `compacts via /compact even when usage is below the soft threshold` — a below-threshold session with `softThresholdPercent: 99` + large context window must call `provider.chat()` and produce ≥1 summary turn.

### Validation
- Verified the regression test FAILS without the fix (provider.chat not called → bug reproduced) and PASSES with it.
- `pnpm -r run build`, `pnpm typecheck`, `pnpm lint:eslint`, `pnpm lint:prettier` all pass.
- Fast suite: 1988 passed / 9 skipped (LSP smoke). Compaction tests: 42 passed.
- LSP zero errors on changed files (the lone hint in `compaction/index.ts` is pre-existing on main).

### Scope notes (unchanged)
- Automatic compaction behavior unchanged.
- `/compact --all` also benefits (forceEvaluateAll had the same latent issue).
- "Compacted…" success message still printed unconditionally — out of scope.