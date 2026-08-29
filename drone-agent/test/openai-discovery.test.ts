import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createOpenAiProvider,
  mapDiscoveredModel,
} from '../src/plugins/openai/openai-driver.js';

// Fixture mirrors the live OpenRouter /models entry shape (captured
// 2026-08-23): catalog metadata rides alongside the id; max_completion_tokens
// is nullable in real payloads.
const OPENROUTER_STYLE_ENTRY = {
  id: 'meta/muse-spark-1.2-contributor',
  canonical_slug: 'meta/muse-spark-1.2-contributor-20260805',
  name: 'Meta: Muse Spark 1.2 Contributor',
  created: 1787336476,
  context_length: 1048576,
  architecture: {
    modality: 'text+image+file+audio+video->text',
    input_modalities: ['text', 'image', 'video', 'file', 'audio'],
    output_modalities: ['text'],
    tokenizer: 'Other',
  },
  pricing: { prompt: '0.0000001', completion: '0.0000002' },
  top_provider: {
    context_length: 1048576,
    max_completion_tokens: null,
    is_moderated: true,
  },
  supported_parameters: ['include_reasoning', 'max_tokens', 'tools'],
};

describe('mapDiscoveredModel', () => {
  it('maps OpenRouter-style metadata take-if-present', () => {
    const mapped = mapDiscoveredModel({
      ...OPENROUTER_STYLE_ENTRY,
      top_provider: {
        ...OPENROUTER_STYLE_ENTRY.top_provider,
        max_completion_tokens: 64000,
      },
    });
    expect(mapped).toEqual({
      id: 'meta/muse-spark-1.2-contributor',
      contextWindow: 1048576,
      maxOutputTokens: 64000,
      hasVision: true,
    });
  });

  it('omits nullable max_completion_tokens entirely', () => {
    const mapped = mapDiscoveredModel(OPENROUTER_STYLE_ENTRY);
    expect(mapped.contextWindow).toBe(1048576);
    expect(mapped.hasVision).toBe(true);
    expect('maxOutputTokens' in mapped).toBe(false);
  });

  it('degrades vanilla-OpenAI bare ids to id-only entries', () => {
    expect(mapDiscoveredModel({ id: 'gpt-4o' })).toEqual({ id: 'gpt-4o' });
  });

  it('ignores non-positive or non-numeric context lengths', () => {
    expect(mapDiscoveredModel({ id: 'x', context_length: 0 })).toEqual({
      id: 'x',
    });
    expect(mapDiscoveredModel({ id: 'x', context_length: 'huge' })).toEqual({
      id: 'x',
    });
  });

  it('does not set hasVision when the image modality is absent', () => {
    const mapped = mapDiscoveredModel({
      id: 'text-only',
      architecture: { input_modalities: ['text'] },
    });
    expect('hasVision' in mapped).toBe(false);
  });
});

describe('openai-family discovery through the driver', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubModelsResponse(payload: unknown, status = 200): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );
  }

  it('enriches discovered entries from an OpenRouter-shaped /models payload', async () => {
    stubModelsResponse({
      data: [OPENROUTER_STYLE_ENTRY, { id: 'openai/gpt-4o' }],
    });
    const { discoverModels } = createOpenAiProvider('OpenRouter', {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
    });
    const models = await discoverModels();

    const enriched = models.find(
      m => m.id === 'meta/muse-spark-1.2-contributor'
    );
    expect(enriched?.contextWindow).toBe(1048576);
    expect(enriched?.hasVision).toBe(true);

    const bare = models.find(m => m.id === 'openai/gpt-4o');
    expect(bare).toEqual({ id: 'openai/gpt-4o' });
  });

  it('surfaces bare ids unchanged when the gateway returns only ids', async () => {
    stubModelsResponse({ data: [{ id: 'm1' }, { id: 'm2' }] });
    const { discoverModels } = createOpenAiProvider('LiteLLM', {
      baseUrl: 'http://localhost:4000/v1',
      apiKey: 'k',
    });
    const models = await discoverModels();
    expect(models).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  it('keeps the descriptive non-ok discovery error', async () => {
    stubModelsResponse({}, 401);
    const { discoverModels } = createOpenAiProvider('OpenRouter', {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'bad',
    });
    await expect(discoverModels()).rejects.toThrow(/discovery failed \(401\)/);
  });
});
