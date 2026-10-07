---
tags: [decision, llm, openrouter, reasoning]
related: [052-reasoning-level.md, modules/drone-core.md]
---

# ADR 083: OpenRouter Reasoning Extraction Fix

**Status**: Implemented (commit `950c9f1`, 2026-07-21)

## Context

OpenRouter returns `reasoning` inside `choice.message.reasoning` (as a field on the message object), but the shared OpenAI-compatible adapter (`fromOpenAiResponse`) only checked `choice.reasoning` (at the choice level). This meant reasoning from OpenRouter was silently dropped — the agent never saw the model's chain-of-thought.

## Decision

Add `reasoning` to the `OpenAiMessage` type and check `choice.message.reasoning` as a fallback in `fromOpenAiResponse`.

### Changes

**`drone-agent/src/shared/openai-compatible.ts`:**
- Added `reasoning?: string` to the `OpenAiMessage` type definition
- After the existing `if (choice.reasoning)` check, added a fallback:
  ```ts
  if (!result.reasoning && choice.message.reasoning) {
    result.reasoning = choice.message.reasoning;
  }
  ```
  Choice-level takes precedence (OpenAI standard), message-level is used as fallback (OpenRouter's behavior).

**Tests:**
- Added test in `openai.test.ts`: `'extracts reasoning from message.reasoning when choice.reasoning is absent'`
- Updated `openrouter.test.ts`: changed existing test to use `message.reasoning` instead of `choice.reasoning` (matching what OpenRouter actually returns)
- Added test in `openrouter.test.ts`: `'prefers choice.reasoning over message.reasoning when both are present'`

## Consequences

### Positive
- OpenRouter reasoning is no longer silently dropped
- Backward compatible — OpenAI's `choice.reasoning` still takes precedence
- All 1599 tests pass

### Negative
- None — minimal, targeted change

## Related

- [[052-reasoning-level]] — Reasoning level control across providers
- [[modules/drone-core]] — Shared types
