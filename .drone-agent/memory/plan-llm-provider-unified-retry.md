---
key: plan-llm-provider-unified-retry
tags:
  - plan
  - llm
  - providers
  - retry
  - error-handling
created: 2026-08-25T16:47:47.934Z
updated: 2026-08-25T16:47:47.934Z
---

# Plan: Unified error/retry semantics across providers

## Summary

Generalize per-provider error handling (openrouter `require_parameters` retry, ollama not-found hint, bare `Error("...API error (status)")` strings across all four drivers) into one shared retry/classification policy. Introduce a structured `DroneLlmError` thrown by drivers; the conversation-service `sendUserMessage` loop owns classification: bounded silent auto-retry on transient HTTP errors → prompt the user to retry on most other HTTP errors → fail fast on transport errors and context overflow.

Why: today a 429/5xx just surfaces as an unhandled Error that crashes plain mode or dumps `Error: ... API error (429)` in the TUI with no retry except re-typing "Keep going" and polluting context.

## LOCKED DESIGN DECISIONS
- **Q1 Error type:** `DroneLlmError` (subclass of Error) in drone-core, THROWN not returned (fail-safe: if handling breaks it surfaces as uncaught error). Fields: `status?`, `retryAfterMs?`, `retryable`, `providerId?`, `body?`.
- **Q2 Tiers:**
  - **T1 bounded silent auto-retry:** 429 (honor Retry-After), 500/502/503/504. Bound exhausted → T2.
  - **T2 prompt user to retry:** every other HTTP status + T1 after retries exhausted. Auth (401/403) too.
  - **T3 fail fast (throw):** non-HTTP / transport.
- **Q3 429/backoff:** maxRetries default 3, maxWaitMs default 30000 (cap single silent wait; beyond → T2). Exponential backoff. CLI flag override for session.
- **Q4 policy location:** conversation-service sendMessage loop. Broker wrapper stays thin (tags providerId, passes DroneLlmError through).
- **Q5 config:** `session.retry = { maxRetries:3, maxWaitMs:30000, promptOnError:true, backoffBaseMs:1000, backoffFactor:2 }`. CLI flag overrides session limits.
- **Q6 non-interactive (no elicitation):** fail fast (throw). Rationale: unbounded silent retry risks runaway billing for never-landed responses.
- **Q7 other issues:** transport/network/bad JSON/bad shape → T3. Context-window-exceeded (400/413/429 "max context length") → detect + fail fast, suggest compaction enabled + manual /compact (scenario: compaction failed AND token estimate undercounted). Degenerate-response guardrails out of scope.
- **Q8 bespoke:** (1) openrouter require_parameters retry stays driver-internal (request-shaping, not time-based); (2) ollama "not found" → DroneLlmError status 404 + helpful hint in message; unified classifies.
- **Q9 UI:** on T2 emit `error` conversation event first (reuses TUI + headless output), then terse yes/no elicit prompt (default no).

## IMPLEMENTATION SURFACES (verified)
- drone-core/src/provider-types.ts — add DroneLlmError; export from index.ts.
- Drivers: openai-driver.ts (chat error ~242 + doFetch/discovery), anthropic-driver.ts (~131), echo-driver.ts (~59), ollama-driver.ts (chat catch + not-found). Parse status + Retry-After.
- Broker: plugins/llm/index.ts getActiveProvider().chat() — catch DroneLlmError, tag providerId, rethrow.
- Conversation-service: sendMessage loop around provider.chat() (~660). Add config.session.retry resolution + classify(retry/prompt/throw). Add onRetryPrompt callback (mirrors onBrokenResponseLimitReached). Emit error event before prompt.
- Config: config-types.ts (DroneSessionConfig + DroneSessionRetryConfig + defaults), config-schema.ts (SessionSchema + RetrySchema), plugins/config/index.ts KNOWN_CONFIG_KEYS add session.retry.*.
- CLI: cli.ts CliOptions + parseCliArgs add --retry-max-retries / --retry-max-wait-ms; index.tsx apply onto resolvedConfig.config.session.retry before createConversationService.
- index.tsx: wire onRetryPrompt → engine.getElicitation() yes/no (default no), non-interactive → false (fail fast).
- Retry-after parsing: integer seconds + HTTP-date (Date.parse fallback).
- Backoff: delay = backoffBaseMs * backoffFactor^(attempt-1), capped at maxWaitMs; Retry-After honored if ≤ cap.
- Context-window detection helper (status 400/413/429 + provider string/regex match) in loop or driver.

## STEPS
1. **DroneLlmError in drone-core** — class + export from index.ts. Verify pnpm -r run build.
2. **Retry helper module** — `drone-agent/src/runtime/llm-retry.ts`: parseRetryAfterMs(header), computeBackoffDelay(attempt, cfg, retryAfterMs), isTransientStatus(status), isContextWindowExceeded(status, message). Unit tests both Retry-After forms + backoff capping.
3. **Convert drivers** to throw DroneLlmError (openai/anthropic/echo/ollama). Read retry-after header, set retryable=isTransientStatus. Ollama not-found → 404 DroneLlmError + "pull it with ollama pull <model>" hint. Keep openrouter require_parameters internal. Update driver tests.
4. **Broker wrapper tags providerId** — plugins/llm/index.ts getActiveProvider().chat() try/catch, set providerId, rethrow. Test.
5. **Config session.retry** — config-types (DroneSessionRetryConfig + DroneSessionConfig.retry + defaults), config-schema RetrySchema, KNOWN_CONFIG_KEYS. Schema/known-keys tests.
6. **Conversation-service policy** — add onRetryPrompt callback to options; wrap provider.chat() in classify: T1 bounded silent retry (emit notice, wait computeBackoffDelay), T2 (emit error event + onRetryPrompt yes/no; no → rethrow), non-interactive/!promptOnError → rethrow, context-window → rethrow with /compact hint, non-DroneLlmError → rethrow. Tests for 429/500 retry-then-prompt, 401 prompt, network throw, context-window hint, non-interactive throw, promptOnError:false throw.
7. **Wire onRetryPrompt in index.tsx** — engine.getElicitation() yes/no default no, non-interactive false.
8. **CLI override flags** — cli.ts CliOptions + parse (--retry-max-retries, --retry-max-wait-ms), index.tsx apply to session.retry before createConversationService. cli parse test.
9. **Full sweep** — pnpm -r build, typecheck, lint, test; LSP zero errors; integration at discretion.

## VALIDATION CRITERIA
- LSP zero errors (typescript connected).
- pnpm -r run build exits 0.
- pnpm typecheck exits 0.
- pnpm lint (eslint + prettier) passes.
- pnpm test fast suite passes, including new: driver DroneLlmError fields, Retry-After parsing, conversation-service classification (T1/T2/T3, non-interactive fail-fast, context-window hint), config schema/known-keys, CLI parse.
- Existing guardrail tests (broken-response, identical-tool-call, stuck-error, tool-iteration) still pass.

## NOTES
- Degenerate-response guardrails out of scope (separate feature).
- openrouter require_parameters retry and ollama hint preserved/adapted, not removed.