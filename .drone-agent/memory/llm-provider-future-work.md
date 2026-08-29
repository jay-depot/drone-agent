---
key: llm-provider-future-work
tags: []
created: 2026-08-23T00:19:03.784Z
updated: 2026-08-25T17:25:40.101Z
---

# LLM provider/model config refactor — future work backlog

Collected during planning of the provider/protocol/model config refactor (2026-08). Kept separate from the implementation plan; each item needs its own planning pass.

## Soon

1. **Usage accounting** — OpenAI-family responses carry a `usage` object that is currently dropped. Capture token counts through the provider response type once the wire contract can be extended safely.
2. **Per-role / per-persona model bindings** — layer over the canonical `<providerId>/<modelLocalId>` selection identity: personas (or roles like main/weak/summarizer) pinning specific models, à la Continue roles / Aider main+weak.
3. **Unified error/retry semantics across providers** — ✅ COMPLETED 2026-08-25. Implemented and validated via `plan-llm-provider-unified-retry`: DroneLlmError in drone-core (thrown, fields status/retryAfterMs/retryable/providerId/body); conversation-service owns tiered classification (T1 bounded silent auto-retry on 429/5xx honoring Retry-After → T2 prompt user on other HTTP statuses → T3 fail fast on transport); session.retry config {maxRetries:3,maxWaitMs:30000,promptOnError:true,backoffBaseMs:1000,backoffFactor:2} wired through config-types/schema/KNOWN_CONFIG_KEYS; onRetryPrompt wired to engine.getElicitation() in index.tsx (non-interactive → fail fast); --retry-max-retries / --retry-max-wait-ms CLI flags; broker tags providerId on DroneLlmError; openrouter require_parameters stays driver-internal; ollama not-found → 404 DroneLlmError with pull hint; context-window-exceeded → fail fast with /compact hint. Original text: generalize bespoke behaviors (openrouter's require_parameters retry on tool-use-unsupported 404, ollama's not-found hint) into shared retry/classification policy.
4. **Session-scoped sampling knobs** — slash commands like `/temperature` riding the parameter resolution chain (provider > model > session), mirroring `/reasoning`.
5. **autoImport wiring** (added 2026-08-23) — persist discovered models as declared `{}` stubs on selection (`DroneAutoImportMode` is schema-typed and documented but has zero behavioral wiring; deliberately deferred from the context-window fixes effort). Root prerequisite: config setValue's static KNOWN_CONFIG_KEYS allowlist cannot express dynamic `providers.<id>.models.<model>` paths — needs pattern-aware validation or a dedicated writer.
6. **Consolidate context-window resolution consumers** (added 2026-08-23) — three hand-rolled resolvers coexist beside the canonical ContextBudgetService.resolveContextWindow: (a) compaction's private `resolveContextWindow` + `calculateFallbackContextWindow` heuristic; (b) swarm session-command.ts `resolveContextWindowTokens` (fallback session.contextWindowTokens ?? 32768). All three route through the broker-enriched getActiveProvider(), so primary resolution is consistent. Consolidation shape: inject the budget service (or its resolveContextWindow fn) into compaction/swarm deps, delete local helpers + divergent fallbacks. Deferred from the context-window-fixes effort to keep that scope tight.

## Later / on demand

7. **Streaming responses** — primary motivation: detect degenerate thought loops early and bail; streaming-token UI is secondary. Requires touching DroneLlmProvider.chat() wire contract.
8. **Bundled model-metadata registry** (models.dev-style snapshot) — declared > discovered > defaults suffices for now; revisit much later.
9. **Gemini / OpenAI Responses protocol plugins** — driver interface must not preclude them; add only when a real user needs them.
10. **Echo provider enhancements** — scripted/hard-coded responses that trigger specific tool calls for testing (out of scope of refactor).

## Context

Parent effort: provider/protocol/model config refactor (providers as data, protocol plugins export LlmProtocolDriver factories). See plan memory for locked decisions; legacy-section auto-migration module will be deleted a few versions after cutover.
