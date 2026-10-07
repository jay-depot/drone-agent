---
tags: [decision, adr, llm, providers, context-window, discovery, model-registry]
related: [157-runtime-truth-context-windows.md, 156-broker-context-windows-migration-persistence.md, 155-provider-model-config.md, ../concepts/provider-model-selection.md]
---

# 196 — Context-window fallback fix: await discovery + bundled model-metadata registry

**Date**: 2026-09-07
**Status**: Accepted (implemented on `fix/new-model-context`, commits `666a8ca` + `aeddd39`)

## Context

Two related defects caused undeclared models to fall back to the 32768
session default context window, even after the ADR 156/157 chain made the
broker-side resolution correct.

1. **Race (OpenRouter).** `resolveActiveContextWindow` read the discovery
   cache without awaiting it. OpenRouter's live catalog carries
   `context_length`, but if discovery hadn't populated the cache yet, the
   window collapsed to 32768. Ollama was unaffected (it has a live probe).
   The existing test masked the race by manually calling `listModels()`
   first.

2. **No metadata source (OpenAI).** Vanilla OpenAI's `/models` returns bare
   ids (no `context_length`), and the driver has no live probe. So even
   with discovery awaited, there was nothing to discover — the window
   still collapsed. The fix needed a **bundled model-metadata registry**
   (models.dev-style snapshot) as a fallback layer in the resolution chain.

A third, latent gap was identified and deferred in ADR 157: Anthropic's
`discoverAnthropicModels` sets only `hasVision`/`supportsTools`, NOT
`contextWindow` — so undeclared Anthropic models also fell back to 32768.
This plan closes that gap too.

## Decision

**Phase 1 — await discovery in `resolveActiveContextWindow`**
(`drone-agent/src/plugins/llm/index.ts`): add `await buildModelListing()`
before `resolveModelMetadata(fullId)`. Cached (60s TTL), non-fatal on
failure, scoped to context-window resolution only. This guarantees the
discovery cache is populated before metadata resolution, so OpenRouter's
live catalog data is present when the window is resolved.

**Phase 2 — bundled model-metadata registry**
(new `drone-agent/src/plugins/llm/model-registry.ts`): a static, checked-in
snapshot keyed by canonical full-form id `<providerId>/<modelLocalId>`,
general by design (not OpenAI-only). Wired into `resolveModelMetadata` as
the fallback layer, extending the chain to:

```
declared > alias-base > discovered > bundled > defaults
```

This benefits `contextWindow`, `maxOutputTokens`, `hasVision`, and
`supportsTools` uniformly (not just context windows), and is a cheap static
map lookup on the existing chat-enrichment path.

Seed data (retrieved 2026-09-07 from developers.openai.com/api/docs/models
and docs.anthropic.com):

- **OpenAI** (current flagship): `gpt-6-astra`, `gpt-5.6-sol`/`terra`/`luna`
  + `gpt-5.6` alias — 1,050,000 ctx / 128k out; legacy `gpt-4.1`/`-mini`/`-nano`
  1,047,576 / 32,768; `gpt-4o` 128,000 / 16,384; `o3`/`o3-mini`/`o4-mini`
  200,000 / 100,000. All vision + tool calling.
- **Anthropic** (the three discovered models): `claude-haiku-4-5` 200k / 64k,
  `claude-sonnet-4-6` 1M / 128k, `claude-opus-4-8` 1M / 128k. These match the
  canonical values already in `drone-core/src/config-types.ts` and
  `drone-agent/src/first-run.tsx`, so declared config, discovery, and bundled
  metadata all agree.

The registry is a snapshot and goes stale as providers ship new models; the
live discovered catalog (which wins over this layer) and declared config
(which wins over both) are preferred.

## Consequences

- Undeclared OpenRouter models resolve their context window from the live
  catalog even on a cold broker (no prior `listModels()` call).
- Undeclared OpenAI and Anthropic models resolve their context window from
  the bundled registry — no live probe, no discovered metadata required.
- The registry feeds all metadata fields uniformly through the existing
  `resolveModelMetadata` chain, so `hasVision`/`supportsTools`/`maxOutputTokens`
  also benefit for metadata-poor providers.
- The registry is a checked-in snapshot; it must be refreshed as providers
  ship new models (documented in the module comment).

## Validation

LSP clean; `pnpm -r run build`, `pnpm lint`, `pnpm typecheck` pass; fast
suite green (196 files / 2777 tests). Both regression tests verified to fail
against pre-fix code (via `git stash` of the source) and pass with the fix:

- **Race test**: a driver whose `discoverModels` returns a model with
  `contextWindow` but WITHOUT a prior `listModels()` call — asserts
  `getContextWindowInfo` resolves `source: 'metadata'`. The discovery
  promise is held unresolved through the harness so the fire-and-forget
  `onPluginsLoaded` warm cannot populate the cache before the probe runs
  (deterministic).
- **Registry tests**: an undeclared OpenAI model (bare-id discovery, no
  `context_length`) and an undeclared Anthropic model (discovery with no
  `contextWindow`) each resolve their window from the bundled registry.

## Related

- [[decisions/157-runtime-truth-context-windows]] — the chain this extends (and whose Anthropic gap it closes)
- [[decisions/156-broker-context-windows-migration-persistence]] — the broker-side chain this completes
- [[decisions/155-provider-model-config]] — the provider/protocol/model refactor
- [[provider-model-selection]] — the metadata resolution chain reference
