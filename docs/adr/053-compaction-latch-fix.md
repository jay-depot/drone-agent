---
tags: [decision, compaction, bug-fix, concurrency]
related: [concepts/session-management.md, modules/drone-agent-plugins.md, flows/tool-call-loop.md]
---

# Decision 053: Compaction `compactionInFlight` Latch Fix

**Status**: Implemented

**Date**: 2026-07-08

## Context

The compaction plugin's re-entrancy guard (`compactionInFlight`) was latched `true` on its first use in every session and never released, permanently disabling compaction. The user only ever saw the conversation service's crude `ensureSafeBudget` drop — summaries never happened.

The root cause is a flag-reset that only happened on the "happy path" exits:

- `hookBody` (and the `forceEvaluate` capability) set `context.compactionInFlight.value = true` *before* calling `maybeCompact()`.
- `maybeCompact` has an early-return for `turns.length === 0` that **does not** reset the flag (compaction/index.ts).
- Every shell (interactive loop, `index.tsx`, `app.tsx`, JSON mode) fires `onBeforePrompt` **before** the user message is appended to the session. So the *first* prompt of a session calls `hookBody` on an empty session: the flag latches `true`, `maybeCompact` hits the empty-turns early return, and the flag stays `true` forever.
- From then on, both `onBeforePrompt` and `onAfterToolCall` bail at `if (context.compactionInFlight.value) return;` — forever. The safety-trim path in the conversation service does the crude drop instead.

### Why the test suite missed it

The test `resets compactionInFlight after the empty-turns early return` was **bogus**: after running `runBeforePrompt(capture)` once on an empty session, it built a *brand-new* plugin and capture (`smallPlugin`/`smallCapture`) for the second call — which has its own fresh `compactionInFlight: { value: false }`. It never exercised the lock state persisting across calls on the *same* instance, so it validated nothing about the failure mode.

## Decision

### 1. Shared `runCompaction` helper + a single `try/finally` reset

Extract a module-level `runCompaction(context, budgetService, systemPrompt)` helper that builds the system messages and calls `maybeCompact`. Wrap **both** `hookBody` and `forceEvaluate` in:

```ts
context.compactionInFlight.value = true;
try {
  await runCompaction(context, budgetService, registration.getConfig().systemPrompt);
} finally {
  context.compactionInFlight.value = false;
}
```

The two top guards (`!config.enabled`, already-in-flight) remain plain early returns *before* the flag is set, so their behavior is unchanged and errors still propagate through `finally`.

### 2. Fixed + added same-instance regression tests

- Rewrote the bogus test to reuse the **same** `capture`/`sessionManager` across both calls (empty session → append 6 long turns → call again; assert exactly one compaction).
- Added a dedicated test driving the real runtime ordering on one instance: `onBeforePrompt` (empty session, latch latches), then `onAfterToolCall` after appending tool-result turns. This mirrors the conversation-service ordering where tool results are appended *before* `onAfterToolCall` fires.

## Consequences

### Positive

- Compaction actually runs now — summaries happen instead of crude drops.
- The latch is released on **every** exit path (the empty-turns early return, the summary-purge return, the `sliceSize <= 0` return, thrown errors), so new early-exit paths can't brick compaction again.
- The guard proof: both new tests FAIL against the original unfixed `index.ts` and PASS after the fix.

### Negative / tradeoffs

- `onBeforePrompt` still fires before the current user message exists, so it only ever sees pre-current-message history. `onAfterToolCall` remains the documented mid-loop workhorse. The registration is kept (per the locked decision) — only the latch was fixed.

## Implementation

- **Commits**: `d417554` ("fix(compaction): release permanent compactionInFlight latch on early exits"), `3eaa769` ("Mark compaction fix plan complete")
- **Files**: `drone-agent/src/plugins/compaction/index.ts`, `drone-agent/test/compaction.test.ts`
- **Validation**: `pnpm typecheck` (all packages), `pnpm lint` (clean), `pnpm test` (1250 passed), LSP clean for both files. Both new tests confirmed to fail pre-fix and pass post-fix.

## Related

- [[concepts/session-management]] — Compaction is driven by the context budget service and runs via plugin hooks.
- [[modules/drone-agent-plugins]] — The `compaction` plugin row.
- [[flows/tool-call-loop]] — Documents the `onAfterToolCall` ordering (after tool results appended).
- Project memory `compaction-bug-review` (root-cause trace) and `compaction-latch-fix-plan` (completed plan) were deleted after ingest.
