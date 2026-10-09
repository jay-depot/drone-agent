---
key: followup-openrouter-error-body-consumed-by-tool-routing-retry
tags:
  - bug
  - openrouter
  - error-reporting
  - followup
  - llm-driver
created: 2026-10-09T22:58:28.626Z
updated: 2026-10-09T22:58:28.626Z
---

Bug (found 2026-10-09): OpenRouter (and any openai-driver-based provider with toolRoutingRetry) shows `OpenRouter API error (4xx): (could not read response body)` — the provider's real error JSON is destroyed before surfacing. Root cause: `maybeToolRoutingRetry` (drone-agent/src/plugins/openai/openai-driver.ts:343-362) unconditionally pre-reads the failed response body with `await failedResponse.text()` (line 354) to sniff the OpenRouter "No endpoints found that support tool use" 404; when it is NOT that error it returns `undefined` (line 361), leaving the body stream consumed. The subsequent `!response.ok` branch (line 239) then calls `response.text()` again (line 242), which throws on the disturbed stream, so the catch (line 244) substitutes the placeholder `(could not read response body)` into the thrown DroneLlmError (lines 255-263, incl. its `body` field). `toolRoutingRetry: true` is hardcoded in the openrouter plugin (drone-agent/src/plugins/openrouter/index.ts:33) and `--debug llm` cannot recover the message because the response debug print (lines 246-251) prints the already-lost body. Affects every non-tool-routing failure: 400 (invalid request / context length), 401, 402 (credits), 403 (data policy / moderation), 429, 5xx. Fix sketch: only pre-read when `failedResponse.status === 404` (cheapest), or have maybeToolRoutingRetry return the pre-read `errorText` when it declines to retry and reuse it in the error branch; same latent pattern does not exist in anthropic-driver (its placeholder at line 127 is a legitimate read-failure fallback). Needs a regression test asserting the real 400 body text appears in the thrown error.