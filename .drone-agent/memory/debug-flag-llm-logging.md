---
key: debug-flag-llm-logging
tags:
  []
created: 2026-07-21T22:00:03.240Z
updated: 2026-07-21T22:09:03.095Z
---

# Plan: `--debug` flag with LLM request/response logging

## Summary

Add a `--debug` CLI flag that accepts a comma-separated list of subsystem names. When `--debug llm` is passed, the LLM providers log their full request and response bodies to stderr. The flag supports both `--debug llm,mcp` and `--debug llm --debug mcp` syntax, consistent with the existing `--plugin` flag.

## Design Decisions

1. **Output goes to stderr** — clean separation from TUI/plain output, can be redirected with `2> debug.log`
2. **Debug flag threaded through `DroneLlmProvider.chat()` input** — the `debug?: boolean` field is added to the chat input type. The conversation service sets it to `true` when `'llm'` is in the debug subsystems set. This is surgical and doesn't pollute the engine or config interfaces.
3. **Each provider logs independently** — the logging is done in each provider's `chat()` function, not in a central place. This keeps the logging close to the actual request/response and avoids needing to reconstruct what was sent.
4. **Log format** — `[llm:request]` and `[llm:response]` prefixed lines to stderr, grep-able and consistent.

## Step-by-Step Implementation

### Step 1: Add `debugSubsystems` to `CliOptions` and parse `--debug` in `cli.ts`

**File:** `drone-agent/src/cli.ts`

**Changes:**
1. Add `debugSubsystems: string[]` to the `CliOptions` type
2. Initialize it as `[]` in the parser
3. Add a `--debug` flag handler (same pattern as `--plugin`):
   - Supports comma-separated: `--debug llm,mcp`
   - Supports repeated flags: `--debug llm --debug mcp`
   - Each value is trimmed and added to the array

### Step 2: Add `debug?: boolean` to `DroneLlmProvider.chat()` input

**File:** `drone-core/src/provider-types.ts`

**Changes:** Add `debug?: boolean` to the chat input type.

### Step 3: Thread debug subsystems through conversation service

**File:** `drone-agent/src/runtime/conversation-service.ts`

**Changes:**
1. Add `debugSubsystems: string[]` to `CreateConversationServiceOptions`
2. Store as a `Set<string>` inside `createConversationService`
3. When calling `provider.chat()`, pass `debug: debugSet.has('llm')`

### Step 4: Wire debug subsystems in `index.tsx`

**File:** `drone-agent/src/index.tsx`

**Changes:** Pass `debugSubsystems` from CLI invocation to conversation service.

### Step 5: Add request/response logging to OpenAI provider

**File:** `drone-agent/src/plugins/openai/index.ts`

**Changes:** Log request body before fetch, read response as text, log it, then parse JSON.

### Step 6: Add request/response logging to OpenRouter provider

**File:** `drone-agent/src/plugins/openrouter/index.ts`

**Changes:** Same pattern, but also log retry request/response on tool-routing errors.

### Step 7: Add request/response logging to Anthropic provider

**File:** `drone-agent/src/plugins/anthropic/index.ts`

**Changes:** Same pattern — log request body, read response as text, log, parse.

### Step 8: Add request/response logging to Ollama provider

**File:** `drone-agent/src/plugins/ollama.ts`

**Changes:** Log input params before `client.chat()`, log response after (library handles the actual HTTP).

### Step 9: Update tests

**Files:** 
- `drone-agent/test/openai.test.ts`
- `drone-agent/test/openrouter.test.ts`
- `drone-agent/test/anthropic.test.ts`
- `drone-agent/test/ollama.test.ts` (if it exists)
- `drone-agent/test/cli.test.ts` (if it exists)

**Changes:**
1. Add a test for each provider that verifies debug output is written to stderr when `debug: true` is passed
2. Add a test for the `--debug` CLI flag parsing
3. Verify that existing tests still pass (debug is optional, defaults to undefined)

### Step 10: Verify

Run `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test`.

## Validation Criteria

1. `pnpm typecheck` passes with zero errors
2. `pnpm lint` passes with zero errors
3. `pnpm build` passes with zero errors
4. `pnpm test` passes — all existing tests + new tests
5. LSP diagnostics clean
6. `--debug llm` flag is parsed correctly (both comma-separated and repeated forms)
7. When `--debug llm` is active, LLM request/response bodies appear on stderr
8. When `--debug llm` is NOT active, no debug output appears on stderr
9. The debug flag is optional — existing behavior is unchanged when omitted

## Work Completed

All 10 steps implemented and validated. 7 files changed. All 1599 tests pass. Typecheck, lint, and build pass cleanly.