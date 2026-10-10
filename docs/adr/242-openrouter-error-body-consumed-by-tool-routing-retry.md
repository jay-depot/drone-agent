---
tags: [openrouter, llm, openai-driver, error-handling, adr]
related:
  [
    decisions/160-unified-llm-error-retry-semantics.md,
    modules/drone-agent-plugins.md,
    concepts/provider-model-selection.md,
  ]
---

# OpenRouter error body survives the tool-routing sniff — read the failed response body exactly once

**Summary**: OpenRouter (and any provider built on the shared OpenAI driver with `toolRoutingRetry`) reported every non-tool-routing HTTP failure as `OpenRouter API error (4xx): (could not read response body)` — the provider's real error JSON was destroyed by the driver's own sniff before the error was ever thrown. `maybeToolRoutingRetry` in `drone-agent/src/plugins/openai/openai-driver.ts` unconditionally pre-read the failed response's body to detect OpenRouter's "No endpoints found that support tool use" 404; when the sniff declined (any other error), it returned `undefined` with the body stream already consumed, so the subsequent error branch's `response.text()` threw and the catch substituted the placeholder into the thrown `DroneLlmError` — masking 400 (invalid request / context length), 401, 402 (credits), 403 (data policy / moderation), 429, and 5xx detail, including from `--debug llm`. Fix: the sniff hands back the body text it already read on decline (`{ errorText }` instead of a bare `undefined`), and the error branch reuses that text, falling back to a fresh read and then the placeholder only when the sniff itself could not read. The body is now read exactly once in every path.

## Context

The openrouter plugin (`drone-agent/src/plugins/openrouter/index.ts`) rides the shared OpenAI driver with `toolRoutingRetry: true` — OpenRouter returns a distinctive 404 (`error.code === 404`, message containing "No endpoints found that support tool use") when a model's endpoints do not support tool use, and the driver retries the same request with `provider.require_parameters: true` to route around it (a driver-internal, request-shaping retry preserved by the unified LLM error/retry design, ADR 160 / locked decision Q8 of that design).

The sniff must read the error body to classify the failure. Pre-fix flow on any non-OK response:

1. `maybeToolRoutingRetry` always did `await failedResponse.text()` and parsed it as `OpenRouterErrorBody`.
2. If `isToolRoutingError(status, body)` was false — i.e. every non-tool-routing failure: 400, 401, 402, 403, 429, 5xx, and also non-routing 404s — it returned `undefined`, leaving the response body stream **consumed**.
3. The `!response.ok` error branch then called `response.text()` again on the disturbed stream. The read threw, so the `catch` substituted the literal `(could not read response body)` into the thrown `DroneLlmError`'s message and `body` field.

The user-visible result for a real-world 400 was:

```
Error: OpenRouter API error (400): (could not read response body)
```

instead of, e.g., OpenRouter's `{"error":{"message":"This model's maximum context length is ... tokens","code":400}}`. The mask also defeated `--debug llm`: the `[llm:response]` debug print in the error branch runs after the body is already lost, so the debug log printed the placeholder too. No other driver shared the defect — the anthropic and echo drivers read the error body exactly once (the anthropic placeholder at the same catch shape is a genuine read-failure fallback), and the OpenAI plugin does not enable `toolRoutingRetry`.

## Decision

1. **The sniff returns what it read when it declines.** `maybeToolRoutingRetry`'s return type widens to `{ response; body } | { errorText } | undefined`. `errorText` is captured before the JSON parse inside the same `try`; on decline the function returns `{ errorText }` when the read succeeded (including non-JSON and empty bodies — the raw text is truthful) and `undefined` only when `response.text()` itself threw (the error branch then does its own read, and a genuine read failure still reaches the placeholder honestly).
2. **The single call site reuses the pre-read text.** `chat()` holds `preReadErrorBody` from a declined sniff; the error branch uses it when present, otherwise falls back to the fresh `response.text()` + placeholder path. The retry path is byte-identical in behavior: sniff-read → (only for the tool-routing 404) one retry fetch; if the retried response is still `!ok`, `preReadErrorBody` is undefined and the error branch reads the retry response's own body.
3. **Body is read exactly once in every path.** Sniff-decline: once (reused). Sniff-retry: once on the failed response, once on the retry response. No sniff (`toolRoutingRetry` off, e.g. the OpenAI plugin): once, unchanged.
4. **No contract changes beyond the module.** `DroneLlmError` shape, the unified conversation-service retry policy, config, and the openrouter plugin are untouched; the change is confined to `openai-driver.ts` (the helper is module-local with exactly one caller, verified by LSP find-references).

## Rationale

- **Handing back the read text beats gating the sniff on `status === 404`**: gating is a smaller diff but leaves the same bug for a non-routing 404 (the sniff still consumes that body before declining), i.e. exactly the status class the sniff inspects. Returning the text fixes every status uniformly and stays robust if the sniff's match conditions ever broaden.
- **A shared cross-driver "read error body once" helper was rejected**: the anthropic and echo drivers are already single-read; a shared abstraction buys nothing today and adds churn.
- **The raw-text-on-decline choice is honest**: a non-JSON body is still the provider's response and belongs in the error; only a stream that cannot be read at all deserves the placeholder.
- **This is the same failure family as ADR 210** (beacon proxy collapsing the coordinator's real error into a generic 502): error-detail-destroying infrastructure one hop from the caller is disproportionately expensive to debug because the symptom reads as "the provider returned nothing useful".

## Implementation

- `drone-agent/src/plugins/openai/openai-driver.ts`
  - `maybeToolRoutingRetry`: `errorText` captured above the JSON parse; decline returns `{ errorText }` / `undefined` per the read outcome; retry path unchanged.
  - `chat()` call site: `preReadErrorBody` captured from a declined sniff; the `!response.ok` branch prefers it over a re-read. Debug print, `Retry-After` parsing, and the `DroneLlmError` construction are unchanged and now see the real body.
- `drone-agent/src/plugins/openrouter/index.ts`, `drone-agent/src/plugins/openai/index.ts` — unchanged.
- No drone-core, config, or schema changes.

## Tests

- `drone-agent/test/openrouter.test.ts`:
  - New regression test "surfaces the real error body when the tool-routing sniff declines" — a stubbed 400 with `error.message = 'This model requires more context: prompt exceeds limit'` must appear in the thrown error's `message` and `body`, the placeholder must be absent, and `fetch` must have been called exactly once. Verified failing pre-fix (message contained the placeholder) and passing post-fix.
  - The existing "does not retry for non-routing errors" test's matcher was strengthened from `'OpenRouter API error (429)'` (which passed even with the bug present) to `'rate limit exceeded'`, pinning the real body on the decline path.
  - Both tool-routing 404 tests (single retry with `require_parameters`, fetch-call counts) pass unchanged.

## Key Points

- **Anything that pre-reads a response body to classify it owns what it read**: a sniff that declines must return the text, not just `undefined`, or it silently destroys the only copy of the error detail downstream code needs.
- **A generic placeholder in an error path is a bug magnet**: `(could not read response body)` looked like a provider/network flake; it was our own double read. Status-code-prefix test matchers (`API error (429)`) pass even with the bug present — assert on real body content.
- **`--debug llm` cannot recover a body that was never retained**: debug prints inside the error branch run after earlier code has consumed the stream; the fix makes the debug output truthful again as a side effect.
- **The driver-internal retry stays driver-internal** (ADR 160, decision Q8) — the unified retry policy is untouched.

## Related

- [160-unified-llm-error-retry-semantics](160-unified-llm-error-retry-semantics.md) — the `DroneLlmError` contract and the decision that the `require_parameters` retry stays driver-internal
- [082-debug-flag-llm-logging](082-debug-flag-llm-logging.md) — the `--debug llm` request/response logging this fix makes truthful on error paths
- [210-beacon-proxy-error-forwarding](210-beacon-proxy-error-forwarding.md) — the same error-detail-masking family, one hop earlier in the stack
