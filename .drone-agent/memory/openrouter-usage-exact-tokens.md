---
key: openrouter-usage-exact-tokens
tags:
  - llm
  - openrouter
  - tokens
  - reasoning
  - observability
created: 2026-09-10T16:53:30.672Z
updated: 2026-09-10T16:53:30.672Z
---

OpenRouter records exact per-request token usage (prompt/completion/total, prompt_tokens_details.cached_tokens, completion_tokens_details.reasoning_tokens, cost) in its activity API — no need for client-side estimation when a provider routes through OpenRouter. Reasoning tokens are separately itemized, which makes thinking-budget behavior (e.g. GLM hybrid thinking ceilings) directly measurable: pull reasoning_tokens across requests and check whether degenerate/failed generations cluster near a round ceiling (cap-yank) or spread organically (overthinking). Prompt-cache hit rate is also visible (cached_tokens/prompt_tokens) — useful since session reasoning is never persisted, so thinking is recomputed and paid fresh every turn.