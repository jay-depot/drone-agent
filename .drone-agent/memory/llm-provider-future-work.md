---
key: llm-provider-future-work
tags:
  - plan
  - backlog
  - llm
  - providers
created: 2026-08-23T00:19:03.784Z
updated: 2026-08-23T00:19:03.784Z
---

# LLM provider/model config refactor — future work backlog

Collected during planning of the provider/protocol/model config refactor (2026-08). Kept separate from the implementation plan; each item needs its own planning pass.

## Soon

1. **Usage accounting** — OpenAI-family responses carry a `usage` object that is currently dropped. Capture token counts through the provider response type once the wire contract can be extended safely.
2. **Per-role / per-persona model bindings** — layer over the canonical `<providerId>/<modelLocalId>` selection identity: personas (or roles like main/weak/summarizer) pinning specific models, à la Continue roles / Aider main+weak.
3. **Unified error/retry semantics across providers** — generalize bespoke behaviors (openrouter's require_parameters retry on tool-use-unsupported 404, ollama's not-found hint) into shared retry/classification policy.
4. **Session-scoped sampling knobs** — slash commands like `/temperature` riding the parameter resolution chain (provider > model > session), mirroring `/reasoning`.

## Later / on demand

5. **Streaming responses** — primary motivation: detect degenerate thought loops early and bail; streaming-token UI is secondary. Requires touching DroneLlmProvider.chat() wire contract.
6. **Bundled model-metadata registry** (models.dev-style snapshot) — declared > discovered > defaults suffices for now; revisit much later.
7. **Gemini / OpenAI Responses protocol plugins** — driver interface must not preclude them; add only when a real user needs them (Gemini mid-transition to Interactions API; Responses conflicts with client-owned sessions).
8. **Echo provider enhancements** — scripted/hard-coded responses that trigger specific tool calls for testing (out of scope of refactor; noted by user).

## Context

Parent effort: provider/protocol/model config refactor (providers as data, protocol plugins export LlmProtocolDriver factories). See plan memory for locked decisions; legacy-section auto-migration module will be deleted a few versions after cutover.
