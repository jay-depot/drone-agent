import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_MODELS,
  NOMIC_EMBED_TEXT_V1_5,
  getEmbeddingModel,
  listEmbeddingModelIds,
  listEmbeddingModels,
} from '../src/embedding-models.js';

describe('embedding model registry', () => {
  it('resolves a model by canonical id', () => {
    expect(getEmbeddingModel('nomic-embed-text-v1.5')).toBe(
      NOMIC_EMBED_TEXT_V1_5
    );
  });

  it('returns undefined for an unknown id', () => {
    expect(getEmbeddingModel('does-not-exist')).toBeUndefined();
  });

  it('formats queries and documents with the model prefixes', () => {
    const spec = NOMIC_EMBED_TEXT_V1_5;
    expect(spec.formatQuery('hello world')).toBe('search_query: hello world');
    expect(spec.formatDocument('hello world')).toBe(
      'search_document: hello world'
    );
  });

  it('lists every registered model', () => {
    const models = listEmbeddingModels();
    expect(models).toHaveLength(EMBEDDING_MODELS.length);
    expect(models.map(model => model.id)).toEqual(listEmbeddingModelIds());
  });

  it('returns a copy so callers cannot mutate the registry', () => {
    const models = listEmbeddingModels();
    models.pop();
    expect(listEmbeddingModels()).toHaveLength(EMBEDDING_MODELS.length);
  });

  it('declares a backend id for every registered backend', () => {
    expect(NOMIC_EMBED_TEXT_V1_5.backends.ollama).toBe('nomic-embed-text:v1.5');
    expect(NOMIC_EMBED_TEXT_V1_5.backends.onnx).toBe(
      'nomic-ai/nomic-embed-text-v1.5'
    );
  });
});
