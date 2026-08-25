---
key: llm-provider-future-work
tags:
  - plan
  - backlog
  - llm
  - providers
created: 2026-08-23T00:19:03.784Z
updated: 2026-08-25T16:48:17.705Z
---

# LLM provider/model config refactor — future work backlog

Collected during planning of the provider/protocol/model config refactor (2026-08). Kept separate from the implementation plan; each item needs its own planning pass.

## Soon

1. **Usage accounting** — OpenAI-family responses carry a `usage` object that is currently dropped. Capture token counts through the provider response type once the wire contract can be extended safely.
2. **Per-role / per-persona model bindings** — layer over the canonical `<providerId>/<modelLocalId>` selection identity: personas (or roles like main/weak/summarizer) pinning specific models, à la Continue roles / Aider main+weak.
3. **Unified error/retry semantics across providers** — ✅ PLANNED. See project memory `plan-llm-provider-unified-retry` (locked design: DroneLlmError in drone-core, thrown; T1 bounded silent auto-retry on 429/500/502/503/504 honoring Retry-After → T2 prompt user on other HTTP statuses → T3 fail fast on transport; session.retry config {maxRetries:3,maxWaitMs:30000,promptOnError:true,backoffBaseMs:1000,backoffFactor:2}; CLI override flags; policy in conversation-service loop; openrouter require_parameters stays driver-internal; ollama not-found → 404 DroneLlmError; context-window-exceeded → fail fast w/ /compact hint; non-interactive → fail fast). Original text: generalize bespoke behaviors (openrouter's require_parameters retry on tool-use-unsupported 404, ollama's not-found hint) into shared retry/classification policy.
4. **Session-scoped sampling knobs** — slash commands like `/temperature` riding the parameter resolution chain (provider > model > session), mirroring `/reasoning`.
5. **autoImport wiring** (added 2026-08-23) — persist discovered models as declared `{}` stubs on selection (`DroneAutoImportMode` is schema-typed and documented but has zero behavioral wiring; deliberately deferred from the context-window fixes effort). Root prerequisite: config setValue's static KNOWN_CONFIG_KEYS allowlist cannot express dynamic `providers.<id>.models.<model>` paths — needs pattern-aware validation or a dedicated writer.
6. **Consolidate context-window resolution consumers** (added 2026-08-23) — three hand-rolled resolvers coexist beside the canonical ContextBudgetService.resolveContextWindow: (a) compaction's private `resolveContextWindow` + `calculateFallbackContextWindow` heuristic (system tokens ÷ softThresholdPercent — self-referential; can produce absurdly small assumed windows when fragments are small, firing compaction too eagerly; compaction/index.ts:103–115, call sites ~215 and ~689); (b) swarm session-command.ts `resolveContextWindowTokens` (fallback session.contextWindowTokens ?? 32768 — semantically fine but a third copy of the plumbing). All three route through the broker-enriched getActiveProvider(), so primary resolution is consistent and they inherit probe-parameter forwarding automatically post-Phase-2. Consolidation shape: inject the budget service (or its resolveContextWindow fn) into compaction/swarm deps, delete local helpers + divergent fallbacks; decide whether the heuristic fallback has any residual value worth preserving (probably not post-decision-156). Deferred from the context-window-fixes effort to keep that scope tight; /context command (Phase 5) provides the empirical verification surface that both paths agree.

## Later / on demand

7. **Streaming responses** — primary motivation: detect degenerate thought loops early and bail; streaming-token UI is secondary. Requires touching DroneLlmProvider.chat() wire contract.
8. **Bundled model-metadata registry** (models.dev-style snapshot) — declared > discovered > defaults suffices for now; revisit much later.
9. **Gemini / OpenAI Responses protocol plugins** — driver interface must not preclude them; add only when a real user needs them (Gemini mid-transition to Interactions API; Responses conflicts with client-owned sessions).
10. **Echo provider enhancements** — scripted/hard-coded responses that trigger specific tool calls for testing (out of scope of refactor; noted by user).

## Context

Parent effort: provider/protocol/model config refactor (providers as data, protocol plugins export LlmProtocolDriver factories). See plan memory for locked decisions; legacy-section auto-migration module will be deleted a few versions after cutover.