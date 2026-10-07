---
tags: [decision, llm, providers, retry, error-handling, conversation-service]
related: [decisions/145-guardrail-reliability-features.md, decisions/155-provider-model-config.md, decisions/157-runtime-truth-context-windows.md, concepts/session-management.md, concepts/provider-model-selection.md, flows/tool-call-loop.md, entities/DroneAgentConfig.md, modules/drone-agent.md, modules/drone-core.md, modules/drone-agent-plugins.md]
---

# 160: Unified LLM Error / Retry Semantics Across Providers

**Status**: Implemented (2026-08-25)

## Context

Every LLM provider driver had bespoke, inconsistent error handling. The four drivers (openai, anthropic, echo, ollama) all threw bare `Error("...API error (status)")` strings; openrouter had a bespoke `require_parameters` retry; ollama had a not-found hint. There was no shared classification: a 429 or 5xx surfaced as an unhandled `Error` that crashed plain output mode or dumped `Error: ... API error (429)` in the TUI, with the only "retry" being the user re-typing "Keep going" — which pollutes the context. Drivers had no Retry-After handling and no structured error surface for the conversation service to reason about.

Goal: generalize into one shared retry/classification policy owned by the conversation service, with a structured error type.

## Decision

### 1. `DroneLlmError` (drone-core)

A structured `DroneLlmError` subclass of `Error` in `drone-core/src/provider-types.ts`, exported from `index.ts`. **Thrown** (not returned) so that if retry handling breaks it surfaces as an uncaught error (fail-safe). Fields:

- `status?` — HTTP status when the failure was an HTTP error
- `retryAfterMs?` — parsed Retry-After delay in ms, if the server supplied one
- `retryable` — whether the driver classifies it as transient/safe to auto-retry
- `providerId?` — tagged by the broker (see §3), not set by drivers
- `body?` — raw response body from the failed request

### 2. Tiered classification

The conversation service's `sendUserMessage` loop owns classification via a `runWithRetry(provider, request)` wrapper:

- **T1 — bounded silent auto-retry**: `429` (honoring Retry-After), `500/502/503/504`. Retry count capped at `session.retry.maxRetries` (default 3), single silent wait capped at `maxWaitMs` (default 30000; beyond → T2). Exponential backoff `backoffBaseMs * backoffFactor^(attempt-1)` (defaults 1000, 2), Retry-After honored if ≤ cap. Emits a `notice` before each silent retry.
- **T2 — prompt the user to retry**: every other HTTP status (auth 401/403 too), plus T1 after retries exhausted. Emits an `error` conversation event first (reuses TUI + headless output), then calls `onRetryPrompt(error, attempt)` for a terse yes/no elicit prompt (default no).
- **T3 — fail fast (throw)**: non-`DroneLlmError` / transport / bad-JSON / bad-shape errors, and context-window-exceeded (see below).

`retryable` is set by the driver via the shared `isTransientStatus()` helper; the conversation service treats `error.retryable || isTransientStatus(status)` as T1-eligible (belt-and-suspenders).

### 3. Context-window overflow → fail fast

Detected via `isContextWindowExceeded(status, message)` when `status` is `400/413/429` AND the message matches a context-window regex (`context length/window/limit/size`, `max context`, `token limit/budget/context/window`, `maximum context`). This fails fast (throws) with a `/compact` hint rather than retrying — retrying would never succeed. Scenario: compaction failed AND the token estimate undercounted the window.

### 4. `session.retry` config

`DroneSessionRetryConfig` in drone-core config-types + defaults + RetrySchema in config-schema + `KNOWN_CONFIG_KEYS` entries:

```ts
session: {
  retry: {
    maxRetries: 3,     // default 3
    maxWaitMs: 30000,  // default 30000
    promptOnError: true,
    backoffBaseMs: 1000,
    backoffFactor: 2,
  },
}
```

### 5. Broker tags `providerId`

The llm broker's `getActiveProvider().chat()` wrapper catches `DroneLlmError`, sets `providerId = instance.providerId` (only if not already set), and rethrows. Drivers don't set providerId themselves — the broker owns it.

### 6. Non-interactive → fail fast

`onRetryPrompt` is wired in `index.tsx` to `engine.getElicitation()`; if there's no elicitation capability (non-interactive/headless), it returns `false` → the service rethrows. Rationale: unbounded silent retry risks a massive bill for responses that never land. `promptOnError: false` also forces T2 → fail fast.

### 7. CLI override flags

`--retry-max-retries N` and `--retry-max-wait-ms N` in `cli.ts` (validated as non-negative finite numbers), applied onto `resolvedConfig.config.session.retry` in `index.tsx` before `createConversationService`. For long-running headless agents.

### 8. Bespoke behaviors preserved

- **OpenRouter `require_parameters`** retry stays driver-internal (request-shaping, not time-based) — unchanged.
- **Ollama "not found"** → a `DroneLlmError` with `status: 404` and a helpful "pull it with `ollama pull <model>`" hint; the unified classifier handles it (non-transient, T2 → T3-ish since 404 isn't transient).
- Degenerate-response guardrails are out of scope (separate feature).

## Key Points

- A single structured error type + conversation-service-owned tiered policy replaces four bespoke driver error strings.
- Bounded silent retry on transient statuses (429/5xx) with Retry-After + exponential backoff honors server guidance without runaway waiting.
- Fail-fast on transport and context overflow; prompt-on-retry for auth and other HTTP statuses; non-interactive fails closed.
- The broker stays thin (tags providerId); the conversation service owns policy.
- Validation: `pnpm -r run build`, `pnpm typecheck`, `pnpm lint`, LSP (zero errors), and the fast suite all pass (2226 passed / 9 skipped; one unrelated pre-existing flaky coordinator broadcast test passes in isolation). New unit tests cover Retry-After parsing (both forms + capping), driver `DroneLlmError` fields, conversation-service classification (T1/T2/T3, non-interactive fail-fast, context-window hint), config schema/known-keys, and CLI parse.

## Related

- [[decisions/145-guardrail-reliability-features]] — the earlier built-in guardrails (degenerate-response retry, identical-call streak), distinct from HTTP error retry
- [[decisions/155-provider-model-config]] — provider/protocol/model refactor the drivers sit within
- [[decisions/157-runtime-truth-context-windows]] — context-window resolution (the overflow-fail-fast detection interacts with it)
- [[concepts/session-management]] — session and guardrail semantics
- [[concepts/provider-model-selection]] — provider selection, drivers
- [[flows/tool-call-loop]] — where the retry wrapper hooks into the loop
- [[entities/DroneAgentConfig]] — `session.retry` config
