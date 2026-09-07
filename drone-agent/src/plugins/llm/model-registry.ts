import type { DiscoveredModel } from 'drone-core';

/**
 * Bundled model-metadata registry (models.dev-style snapshot).
 *
 * A static, checked-in fallback layer for providers whose discovery is
 * metadata-poor. Vanilla OpenAI's `/models` returns bare ids (no
 * `context_length`), and the driver has no live probe — so without this
 * registry undeclared OpenAI models collapse to the session default context
 * window. OpenRouter's live catalog already carries `context_length` for most
 * models, so the registry is mainly for metadata-poor providers.
 *
 * This is a snapshot and goes stale as providers ship new models. Prefer the
 * live discovered catalog (which wins over this layer) and declared config
 * (which wins over both). Keyed by canonical full-form id
 * `<providerId>/<modelLocalId>`.
 */
export const BUNDLED_MODEL_METADATA: Record<
  string,
  Partial<DiscoveredModel>
> = {
  // Current flagship lineup (September 2026)
  'openai/gpt-6-astra': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    hasVision: true,
    supportsTools: true,
  },
  'openai/gpt-5.6-sol': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    hasVision: true,
    supportsTools: true,
  },
  'openai/gpt-5.6': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    hasVision: true,
    supportsTools: true,
  }, // alias of gpt-5.6-sol
  'openai/gpt-5.6-terra': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    hasVision: true,
    supportsTools: true,
  },
  'openai/gpt-5.6-luna': {
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    hasVision: true,
    supportsTools: true,
  },

  // Legacy models (still available, being deprecated)
  'openai/gpt-4.1': {
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    hasVision: true,
    supportsTools: true,
  },
  'openai/gpt-4.1-mini': {
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    hasVision: true,
    supportsTools: true,
  },
  'openai/gpt-4.1-nano': {
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    hasVision: true,
    supportsTools: true,
  },
  'openai/gpt-4o': {
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    hasVision: true,
    supportsTools: true,
  },
  'openai/o3': {
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    hasVision: true,
    supportsTools: true,
  },
  'openai/o3-mini': {
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    hasVision: true,
    supportsTools: true,
  },
  'openai/o4-mini': {
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    hasVision: true,
    supportsTools: true,
  },
};
