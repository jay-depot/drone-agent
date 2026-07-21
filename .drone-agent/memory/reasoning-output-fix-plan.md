---
key: reasoning-output-fix-plan
tags:
  []
created: 2026-07-21T21:11:27.913Z
updated: 2026-07-21T21:23:14.780Z
---

# Plan: Fix Reasoning Output for All LLM Providers

## Summary

The `DroneChatResponse` type has a `reasoning` field that the conversation service already consumes and the TUI already renders. However, only the Ollama provider populates it. OpenRouter sends reasoning in the request but doesn't extract it from the response. OpenAI doesn't send reasoning in the request *or* extract it from the response. Anthropic does neither. This plan fixes all three providers so reasoning output flows end-to-end.

## Design Decisions

1. **OpenAI vs OpenRouter format**: OpenAI uses `reasoning_effort` (top-level, snake_case); OpenRouter uses `reasoning: { effort: ... }` (nested). Both fields will be available on `OpenAiChatRequest` — each plugin uses the format its API expects. The API ignores fields it doesn't understand.
2. **Anthropic thinking budget**: 50% of `config.session.responseReserveTokens` as `budget_tokens`.
3. **Anthropic signature blocks**: Silently skipped — they're redacted hashes for Anthropic's internal verification.

## Step-by-Step Implementation

### Step 1: Update shared types in `openai-compatible.ts`

**File:** `drone-agent/src/shared/openai-compatible.ts`

**Changes:**
1. Add `reasoning_effort?: string` to `OpenAiChatRequest` (native OpenAI format, alongside existing `reasoning?: { effort: string }` for OpenRouter)
2. Add `reasoning?: string` to `OpenAiChatChoice` (the OpenAI API returns reasoning as a top-level field on the choice object)

### Step 2: Update `fromOpenAiResponse()` to extract reasoning

**File:** `drone-agent/src/shared/openai-compatible.ts`

**Changes:** After extracting `choice.message.content`, also extract `choice.reasoning` and set it on `result.reasoning`.

### Step 3: Update OpenAI plugin to send reasoning in request

**File:** `drone-agent/src/plugins/openai/index.ts`

**Changes:**
1. Destructure `reasoningLevel` from the `chat()` input
2. Map `DroneReasoningLevel` to OpenAI's `reasoning_effort` values
3. Set `reasoning_effort` on the request body

### Step 4: Update Anthropic types in `anthropic-adapter.ts`

**File:** `drone-agent/src/plugins/anthropic/anthropic-adapter.ts`

**Changes:**
1. Add `thinking` field to `AnthropicChatRequest`
2. Add `AnthropicThinkingBlock` and `AnthropicSignatureBlock` types
3. Update `AnthropicContentBlock` union

### Step 5: Update `fromAnthropicResponse()` to extract reasoning

**File:** `drone-agent/src/plugins/anthropic/anthropic-adapter.ts`

**Changes:** Handle `type: 'thinking'` (extract text into `result.reasoning`) and `type: 'signature'` (silently skip).

### Step 6: Update `toAnthropicRequestParts()` to accept reasoningLevel and set thinking

**File:** `drone-agent/src/plugins/anthropic/anthropic-adapter.ts`

**Changes:** Add `reasoningLevel` parameter; set `thinking` with `budget_tokens: Math.floor(maxTokens * 0.5)` when reasoning is enabled.

### Step 7: Update Anthropic plugin to pass reasoningLevel through

**File:** `drone-agent/src/plugins/anthropic/index.ts`

**Changes:** Pass `reasoningLevel` to `toAnthropicRequestParts()`.

### Step 8: Add tests

- `drone-agent/test/openai.test.ts` — reasoning_effort in request, reasoning extraction, absent reasoning
- `drone-agent/test/openrouter.test.ts` — reasoning extraction from response
- `drone-agent/test/anthropic.test.ts` — thinking in request, thinking off, thinking block extraction, signature block skipping

### Step 9: Verify

Run `pnpm lint:eslint`, `pnpm lint:prettier`, `pnpm build`, `pnpm test`.

## Validation Criteria

All met. See commit 9f1657d on branch `reasoning-output-fix`.

## Work Completed

All 11 steps implemented and validated. 10 files changed, 380 insertions, 22 deletions. All 1599 tests pass. Lint and build pass cleanly.
