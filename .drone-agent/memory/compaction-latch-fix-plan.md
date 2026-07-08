---
key: compaction-latch-fix-plan
tags: []
created: 2026-07-08T03:24:20.702Z
updated: 2026-07-08T03:24:20.702Z
---

# Plan: Fix the permanent `compactionInFlight` latch bug

## Summary

The compaction plugin's re-entrancy guard (`compactionInFlight`) is latched `true` and never released on early-exit paths of `maybeCompact`. Every shell fires `onBeforePrompt` _before_ the user message is appended (`interactive.ts`, `index.tsx`, `app.tsx`), so the first prompt of a session hits the `turns.length === 0` early return with the flag already set — and it stays set forever. Compaction never runs; the user only sees the conversation service's crude `ensureSafeBudget` drop (`conversation-service.ts:203`). Fix: wrap the flag-setting logic in `try/finally` (via a shared helper) for **both** the registered hook and the `forceEvaluate` capability, and replace a bogus regression test with real same-instance coverage.

## Files changed

- `drone-agent/src/plugins/compaction/index.ts` — extract `runCompaction` helper; `try/finally` in `hookBody` and `forceEvaluate`.
- `drone-agent/test/compaction.test.ts` — fix the in-place test; add a dedicated regression test.

## Steps

1. **Extract `runCompaction` helper** (coder): module-level async fn that builds system messages and calls `maybeCompact` (body currently duplicated in `hookBody` and `forceEvaluate`):
   ```ts
   async function runCompaction(
     context: RegistrationContext,
     budgetService: ContextBudgetService,
     systemPrompt: string
   ): Promise<void> {
     const systemMessages = await budgetService.buildSystemMessages();
     const baseSystemMessages: DroneChatMessage[] = [
       { role: 'system', content: systemPrompt },
     ];
     const fragmentMessages = systemMessages.slice(1);
     await maybeCompact({ context, baseSystemMessages, fragmentMessages });
   }
   ```
2. **Wrap `hookBody` in `try/finally`** (coder): the two top guards (`!config.enabled`, already in-flight) stay plain early returns; set flag then `try { await runCompaction(...) } finally { context.compactionInFlight.value = false; }`.
3. **Wrap `forceEvaluate` in `try/finally`** (coder): identical pattern — same latent bug class.
4. **Fix bogus in-place test** (tester/coder): the test `resets compactionInFlight after the empty-turns early return` (~lines 689-715) builds a brand-new `smallPlugin`/`smallCapture` for the 2nd call, so it never exercises the lock persisting on one instance. Rewrite to reuse the SAME `capture`: single provider (contextWindow 200, chatResponses `[{message:'Summary after adding turns.'}]`), `runBeforePrompt(capture)` on empty session, append 6 long turns to same sessionManager, `runBeforePrompt(capture)` again, assert chat called once + 1 summary turn. Delete the small\*/smallProvider/smallCapture blocks.
5. **Add dedicated same-instance regression test** (tester/coder): drive the real runtime sequence on ONE instance — `runBeforePrompt(capture)` on empty session (flag latches, early return), append 6 long turns, `runAfterToolCall(capture)`, assert chat called once + 1 summary turn. This mirrors the conversation-service ordering where tool results are appended before `onAfterToolCall` fires.
6. **Review** (reviewer): confirm `finally` covers all exits; no behavior change for disabled/in-flight guards; "ollama provider missing" test still rejects (errors propagate through `finally`); new/updated tests fail pre-fix and pass post-fix.
7. **Validate** (coder/tester): run the full gate below; fix failures.

## Validation criteria

- `pnpm typecheck` passes.
- `pnpm lint` passes (ESLint + Prettier — the project lint process).
- `pnpm test` passes; `drone-agent/test/compaction.test.ts` green.
- LSP diagnostics clean for both changed files.
- Steps 4-5 tests confirmed to FAIL against original (unfixed) `index.ts`, proving they guard the bug.

## Decisions (locked with user)

- Q1: Keep `onBeforePrompt` registered; only fix the latch.
- Q2: Fix the in-place test AND add a dedicated same-instance regression test.
- Q3: Fix `forceEvaluate` too (same bug class).
- Q4: Extract a shared `runCompaction` helper + single `try/finally` (not duplicated per-site).
