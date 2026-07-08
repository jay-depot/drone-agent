---
key: reasoning-level-api-control
tags:
  - llm
  - providers
  - reasoning
  - anthropic
  - openai
  - ollama
  - ollama-cloud
  - config
  - research
created: 2026-07-08T02:30:32.462Z
updated: 2026-07-08T02:30:32.462Z
---

# Reasoning-Level Controls Across Anthropic, OpenAI, Ollama (incl. Ollama Cloud)

Research consolidated for implementing a unified reasoning-level control in drone-agent.

## 1. Anthropic (Claude)
Current control: the `effort` parameter inside `output_config` (no beta header required):
```python
client.messages.create(model="claude-opus-4-8", max_tokens=4096, messages=[...],
                       output_config={"effort": "medium"})
```
- Values: `max`, `xhigh`, `high` (DEFAULT — same as omitting), `medium`, `low`.
- `effort` is a *behavioral signal*, not a hard token budget. Affects ALL response tokens (text, tool calls, thinking). At higher levels Claude almost always thinks; lower levels may skip thinking on simple tasks.
- Model availability: Fable 5, Mythos 5, Opus 4.5–4.8, Sonnet 4.6/5. `xhigh` unavailable on some (e.g. not Opus 4.6).
- Legacy/model-specific: `thinking` block. Adaptive thinking (recommended Opus 4.7/4.8, Sonnet 5): `thinking: {type: "adaptive"}`; effort controls depth. Manual (Opus 4.5 and older): `thinking: {type: "enabled", budget_tokens: N}`. `thinking: {type: "disabled"}` rejected on Fable 5 / Mythos 5 (thinking always on). `budget_tokens` is deprecated, slated for removal.
- At `xhigh`/`max`, set large `max_tokens` (Anthropic suggests starting 64k).

## 2. OpenAI (GPT-5.x, o-series)
Current control: `reasoning.effort` object on the **Responses API** (`POST /v1/responses`):
```python
client.responses.create(model="gpt-5.5", reasoning={"effort": "low"}, input=[...])
```
- Values (model-dependent subset): `none`, `minimal`, `low`, `medium`, `high`, `xhigh`.
- Defaults model-specific; `gpt-5.5` defaults to `medium` (recommended start).
- Adaptive within a level. Reasoning tokens billed as output tokens; cap via `max_output_tokens`. Recommend reserving >=25,000 tokens for reasoning+output. Reaching limit -> `status:"incomplete"`, `incomplete_details.reason:"max_output_tokens"`.
- Companions: `reasoning.summary` (`auto`/`concise`/`detailed`); `reasoning.encrypted_content` for stateless multi-turn.
- Chat Completions `reasoning_effort` top-level is the historical equivalent; Responses API structured `reasoning:{effort}` is current/preferred.

## 3. Ollama (self-hosted, native API)
Native `think` top-level field on `/api/generate` and `/api/chat`:
```bash
curl http://localhost:11434/api/chat -d '{"model":"deepseek-r1","messages":[...],"think":true,"stream":false}'
```
- Boolean: `true` (enabled, separates `thinking` from `content`) / `false` (disabled). On by default in CLI/API for thinking models.
- Level form (newer): `"low"`, `"medium"`, `"high"`, `"max"` (also accepted).
- Thinking-capable: DeepSeek-R1, Qwen3, DeepSeek-v3.1, GPT-OSS, etc. Non-thinking models ignore the flag.
- GPT-OSS ONLY accepts levels (`low`/`medium`/`high`); `true`/`false` ignored; trace cannot be fully disabled.
- CLI: `ollama run model --think` / `--think=false`; interactive `/set think` / `/set nothink`; `--hidethinking` to suppress trace.

## 4. Ollama Cloud — does NOT extend native `think`
- Cloud models use the SAME Ollama API on a different base URL: `https://ollama.com/api` (auth via `OLLAMA_API_KEY`). The native `think` param is identical to self-hosted.
- The "extra options" come from Ollama's **compatibility endpoints**, reachable on the cloud base URL:
  - **OpenAI-compat** `https://ollama.com/api/v1/chat/completions` (and `/v1/responses`, added v0.13.3): supports `reasoning_effort` and `reasoning.effort` with values `none`/`low`/`medium`/`high`/`max` (OpenAI vocabulary, incl. `none` not expressible via native `think` boolean).
  - **Anthropic-compat** `https://ollama.com/api/v1/messages`: supports `thinking` (extended thinking); `budget_tokens` accepted but NOT enforced (partial support only).
- Trade-off: compatibility shims are thinner (e.g. Anthropic `budget_tokens` not enforced; no `previous_response_id` on `/v1/responses`). Native `think` levels remain the most faithful control.

### Ollama reasoning-control surface matrix
| Surface (incl. cloud) | Param | Values | Notes |
|---|---|---|---|
| Native `/api/chat`,`/api/generate` | `think` | `true`/`false`, `"low"`/`"medium"`/`"high"`/`"max"` | GPT-OSS: levels only |
| OpenAI-compat `/v1/chat/completions` | `reasoning_effort` or `reasoning.effort` | `none`/`low`/`medium`/`high`/`max` | OpenAI vocabulary |
| Anthropic-compat `/v1/messages` | `thinking` (+`budget_tokens`) | enabled/adaptive style | `budget_tokens` accepted but not enforced |

## 5. Cross-provider comparison (consolidated)
| Provider | Param | Location | Values | Default |
|---|---|---|---|---|
| Anthropic | `effort` (new) / `thinking` (legacy) | `output_config.effort` / `thinking` block | `low` `medium` `high`(def) `xhigh` `max` | `high` |
| OpenAI | `reasoning.effort` | `reasoning` obj (Responses API) | `none` `minimal` `low` `medium`(gpt-5.5 def) `high` `xhigh` | `medium` (gpt-5.5) |
| Ollama native | `think` | top-level body | bool or `low`/`medium`/`high`/`max` | thinking ON |
| Ollama via OpenAI-compat | `reasoning_effort` | `reasoning` obj | `none`/`low`/`medium`/`high`/`max` | model-dependent |
| Ollama via Anthropic-compat | `thinking` | `thinking` block | enabled/adaptive | n/a |

### Implementation guidance for a unified `reasoningLevel`
- No universal enum: common tail `low`/`medium`/`high`/`max`; Anthropic adds `xhigh`; OpenAI adds `none`/`minimal`/`xhigh`; Ollama native lacks `none` and `minimal`.
- A normalized enum (e.g. `off`/`low`/`medium`/`high`/`max`/`xhigh`) must map per-provider, with provider-specific pass-through for raw values (esp. OpenAI `none`/`minimal`/`xhigh`, Anthropic `xhigh`).
- Defaults differ (Anthropic `high`, OpenAI `medium`, Ollama thinking ON) — a unified default should be provider-aware.
- GPT-OSS requires level strings, not boolean — provider/model dispatch needed.

## 6. Source index
- Anthropic Effort: https://platform.claude.com/docs/en/build-with-claude/effort
- Anthropic Extended/Adaptive Thinking: https://platform.claude.com/docs/en/build-with-claude/extended-thinking , /adaptive-thinking
- OpenAI Reasoning guide: https://developers.openai.com/api/docs/guides/reasoning
- Ollama native API (api.md): https://github.com/ollama/ollama/blob/main/docs/api.md
- Ollama Thinking blog: https://ollama.com/blog/thinking
- Ollama Cloud guide: https://docs.ollama.com/cloud
- Ollama Thinking capability: https://docs.ollama.com/capabilities/thinking
- Ollama OpenAI compat: https://docs.ollama.com/api/openai-compatibility
- Ollama Anthropic compat: https://docs.ollama.com/api/anthropic-compatibility
- Ollama API intro: https://docs.ollama.com/api/introduction