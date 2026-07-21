---
key: reasoning-output-fix-plan
tags:
  []
created: 2026-07-21T21:11:27.913Z
updated: 2026-07-21T22:26:22.597Z
---

## Plan: Fix OpenRouter Reasoning Extraction

### Summary
OpenRouter returns `reasoning` inside `choice.message.reasoning` (as a field on the message object), but the shared OpenAI-compatible adapter (`fromOpenAiResponse`) only checks `choice.reasoning` (at the choice level). This means reasoning from OpenRouter is silently dropped.

The fix is to add `reasoning` to the `OpenAiMessage` type and check `choice.message.reasoning` as a fallback in `fromOpenAiResponse`.

### Files to modify
1. `drone-agent/src/shared/openai-compatible.ts` — type + parser fix
2. `drone-agent/test/openai.test.ts` — add test for message-level reasoning
3. `drone-agent/test/openrouter.test.ts` — add test for message-level reasoning, update existing test

### Steps

**Step 1: Add `reasoning` field to `OpenAiMessage` type**
File: `drone-agent/src/shared/openai-compatible.ts`
- Add `reasoning?: string` to the `OpenAiMessage` type definition (around line 8)

**Step 2: Update `fromOpenAiResponse` to check message-level reasoning**
File: `drone-agent/src/shared/openai-compatible.ts`
- After the existing `if (choice.reasoning)` check, add a fallback:
  ```ts
  if (!result.reasoning && choice.message.reasoning) {
    result.reasoning = choice.message.reasoning;
  }
  ```
  This ensures choice-level takes precedence (OpenAI standard), but message-level is used as fallback (OpenRouter's behavior).

**Step 3: Add test for message-level reasoning in openai.test.ts**
File: `drone-agent/test/openai.test.ts`
- Add a test case: `'extracts reasoning from message.reasoning when choice.reasoning is absent'`
- Mock response with `reasoning` inside `message` but not at `choice` level
- Verify `response.reasoning` is extracted correctly

**Step 4: Update openrouter.test.ts**
File: `drone-agent/test/openrouter.test.ts`
- Update the existing `'extracts reasoning from response when choice.reasoning is present'` test to use `message.reasoning` instead of `choice.reasoning` (since that's what OpenRouter actually returns)
- Add a new test: `'prefers choice.reasoning over message.reasoning when both are present'` to cover the precedence path

**Step 5: Verify**
- Run `pnpm -r run typecheck` — must pass
- Run `pnpm -r run lint` — must pass
- Run `pnpm -r run test` — must pass (specifically the openai and openrouter test files)
- Run `pnpm -r run build` — must pass

### Validation Criteria
- [x] LSP diagnostics pass with zero errors
- [x] `pnpm -r run typecheck` passes
- [x] `pnpm -r run lint` passes
- [x] `pnpm -r run test` passes (all tests, including new ones)
- [x] `pnpm -r run build` passes
- [x] The `fromOpenAiResponse` function extracts reasoning from `choice.message.reasoning` when `choice.reasoning` is absent
- [x] The `fromOpenAiResponse` function still prefers `choice.reasoning` over `choice.message.reasoning` when both are present
- [x] No regressions in existing reasoning tests

### Completed
Commit `950c9f1` on branch `reasoning-output-fix`. All validation criteria satisfied.