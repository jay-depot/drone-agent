---
key: plan-new-model-context-race-fix
tags:
  - plan
  - llm
  - context-window
  - discovery
  - race-condition
  - model-registry
created: 2026-09-07T21:14:27.546Z
updated: 2026-09-07T22:04:26.530Z
---

# Plan: Fix context-window fallback for undeclared models

## Summary
Two related defects cause undeclared models to fall back to the 32768 default:

1. **Race (OpenRouter):** `resolveActiveContextWindow` reads the discovery cache without awaiting it. OpenRouter's live catalog carries `context_length`, but if discovery hasn't populated the cache yet, the window collapses to 32768. Ollama is unaffected (it has a live probe).
2. **No metadata source (OpenAI):** vanilla OpenAI's `/models` returns bare ids (no `context_length`), and the driver has no live probe. So even with discovery awaited, there's nothing to discover. Fix: a **bundled model-metadata registry** (models.dev-style snapshot) as a fallback layer in the resolution chain.

## Phase 1 — Race fix (OpenRouter)

### Step 1 — Await discovery in `resolveActiveContextWindow`
File: `drone-agent/src/plugins/llm/index.ts`
Add `await buildModelListing();` before `resolveModelMetadata(fullId)`. Cached (60s TTL), non-fatal on failure, scoped to context-window resolution only.

### Step 2 — Regression test (race)
File: `drone-agent/test/llm-context-window.test.ts`
Driver's `discoverModels` returns a model with `contextWindow`, but WITHOUT calling `listModels()` first. Assert `getContextWindowInfo` resolves `source: 'metadata'`. Fails pre-fix, passes post-fix.

## Phase 2 — Bundled model-metadata registry (OpenAI)

### Step 3 — Create the registry module
File: `drone-agent/src/plugins/llm/model-registry.ts` (new)
A static, checked-in snapshot keyed by canonical full-form id `<providerId>/<modelLocalId>`. General by design (not OpenAI-only) — the seed data is OpenAI because that's the gap. A comment notes it's a snapshot that goes stale; OpenRouter's live catalog already covers most models, so the registry is mainly for metadata-poor providers.

Seed data (retrieved 2026-09-07 from developers.openai.com/api/docs/models):

```typescript
export const BUNDLED_MODEL_METADATA: Record<string, Partial<DiscoveredModel>> = {
  // Current flagship lineup (September 2026)
  'openai/gpt-6-astra':   { contextWindow: 1_050_000, maxOutputTokens: 128_000, hasVision: true, supportsTools: true },
  'openai/gpt-5.6-sol':   { contextWindow: 1_050_000, maxOutputTokens: 128_000, hasVision: true, supportsTools: true },
  'openai/gpt-5.6':       { contextWindow: 1_050_000, maxOutputTokens: 128_000, hasVision: true, supportsTools: true }, // alias of gpt-5.6-sol
  'openai/gpt-5.6-terra': { contextWindow: 1_050_000, maxOutputTokens: 128_000, hasVision: true, supportsTools: true },
  'openai/gpt-5.6-luna':  { contextWindow: 1_050_000, maxOutputTokens: 128_000, hasVision: true, supportsTools: true },

  // Legacy models (still available, being deprecated)
  'openai/gpt-4.1':       { contextWindow: 1_047_576, maxOutputTokens: 32_768, hasVision: true, supportsTools: true },
  'openai/gpt-4.1-mini':  { contextWindow: 1_047_576, maxOutputTokens: 32_768, hasVision: true, supportsTools: true },
  'openai/gpt-4.1-nano':  { contextWindow: 1_047_576, maxOutputTokens: 32_768, hasVision: true, supportsTools: true },
  'openai/gpt-4o':        { contextWindow: 128_000,    maxOutputTokens: 16_384, hasVision: true, supportsTools: true },
  'openai/o3':            { contextWindow: 200_000,    maxOutputTokens: 100_000, hasVision: true, supportsTools: true },
  'openai/o3-mini':       { contextWindow: 200_000,    maxOutputTokens: 100_000, hasVision: true, supportsTools: true },
  'openai/o4-mini':       { contextWindow: 200_000,    maxOutputTokens: 100_000, hasVision: true, supportsTools: true },
};
```

Notes: all current OpenAI models support vision + function calling (uniform). gpt-4.1-nano, o3-mini, o4-mini shut down Oct 23 2026; o3 shuts down Dec 11 2026 (deprecation timing noted but not encoded as a flag — the registry is a snapshot). gpt-4.1, gpt-4.1-mini, gpt-4o are legacy but not on the current deprecation list.

### Step 4 — Wire the registry into `resolveModelMetadata`
File: `drone-agent/src/plugins/llm/index.ts`
Extend the resolution chain to: **declared > alias-base > discovered > bundled > defaults**. This benefits `contextWindow`, `maxOutputTokens`, `hasVision`, and `supportsTools` uniformly (not just context windows), and it's a cheap static map lookup on the existing chat-enrichment path.

### Step 5 — Regression test (registry)
File: `drone-agent/test/llm-context-window.test.ts`
An undeclared OpenAI model (bare-id discovery, no `context_length`) resolves its context window from the bundled registry — no live probe, no discovered metadata. Fails pre-fix, passes post-fix.

## Phase 3 — Validation

### Step 6 — Full validation
- LSP clean
- `pnpm -r run build`
- `pnpm -r run lint`
- Fast test suite (`pnpm -r run test`) green, including both new regression tests

## Validation criteria
- LSP checks pass (no exceptions)
- `pnpm -r run build` passes with zero errors
- `pnpm -r run lint` passes with zero errors
- Fast test suite passes, including both new regression tests
- Both regression tests fail against pre-fix code and pass with the fix

## Decisions locked
- Registry feeds all metadata fields (contextWindow, maxOutputTokens, hasVision, supportsTools) via resolveModelMetadata, not just context windows.
- Seed data is OpenAI-only for now. Anthropic's hardcoded discovery (discoverAnthropicModels) sets only hasVision/supportsTools, NOT contextWindow — so anthropic models also fall back to 32768 for context windows unless declared. This is a latent gap, deferred to a separate pass.
- Both phases merged into one plan (shared validation).

## Sources
- OpenAI model catalog: https://developers.openai.com/api/docs/models
- Model comparison: https://developers.openai.com/api/docs/models/compare
- Deprecations: https://developers.openai.com/api/docs/deprecations
- Data retrieved 2026-09-07.