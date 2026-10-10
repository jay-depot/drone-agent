---
key: followup-openrouter-error-body-consumed-by-tool-routing-retry
tags:
  - bug
  - openrouter
  - error-reporting
  - followup
  - llm-driver
created: 2026-10-09T22:58:28.626Z
updated: 2026-10-09T23:19:00.000Z
resolved: true
---

**Status: RESOLVED (2026-10-09) — fixed by ADR 242 (`docs/adr/242-openrouter-error-body-consumed-by-tool-routing-retry.md`), committed on `feat/swarm-config-startup-underlay`.**

Fix as executed (option 2): `maybeToolRoutingRetry` (drone-agent/src/plugins/openai/openai-driver.ts) captures `errorText` before the JSON parse and returns `{ errorText }` on decline — bare `undefined` only when `response.text()` itself threw — and the single call site in `chat()` stores it as `preReadErrorBody`, which the error branch reuses (fresh read + placeholder only when the sniff could not read). The failed response body is now read exactly once in every path; the tool-routing retry path is unchanged. Tests: new regression test "surfaces the real error body when the tool-routing sniff declines" (fails pre-fix with the placeholder message, passes post-fix) + the existing 429-decline test matcher strengthened to the real body ('rate limit exceeded'). Gates: fast suite 3795 passed / 0 failed, typecheck, build, lint, LSP all clean. The `status === 404` pre-read-gating sketch below is obsolete (rejected during planning: a non-routing 404 would still lose its body).

Original report (2026-10-09): OpenRouter (and any openai-driver-based provider with toolRoutingRetry) shows `OpenRouter API error (4xx): (could not read response body)` — the provider's real error JSON is destroyed before surfacing. Root cause: `maybeToolRoutingRetry` unconditionally pre-reads the failed response body with `await failedResponse.text()` to sniff the OpenRouter "No endpoints found that support tool use" 404; when it is NOT that error it returns `undefined`, leaving the body stream consumed. The subsequent `!response.ok` branch then calls `response.text()` again, which throws on the disturbed stream, so the catch substitutes the placeholder `(could not read response body)` into the thrown DroneLlmError (message + `body` field). `toolRoutingRetry: true` is hardcoded in the openrouter plugin and `--debug llm` cannot recover the message because the response debug print runs after the body is already lost. Affects every non-tool-routing failure: 400 (invalid request / context length), 401, 402 (credits), 403 (data policy / moderation), 429, 5xx. The anthropic driver's identical placeholder is a legitimate read-failure fallback — that driver reads the body once and is unaffected.
