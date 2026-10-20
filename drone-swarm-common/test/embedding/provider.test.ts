import { NOMIC_EMBED_TEXT_V1_5 } from 'drone-core';
import { describe, expect, it } from 'vitest';

import { createEmbeddingProvider } from '../../src/embedding/provider.js';
import type { EmbeddingBackend } from '../../src/embedding/types.js';

function recordingBackend(): EmbeddingBackend & { seen: string[] } {
  const seen: string[] = [];
  return {
    id: 'fake',
    dtype: 'q8',
    seen,
    init: async () => {},
    dispose: async () => {},
    async embed(texts: string[]): Promise<Float32Array[]> {
      seen.push(...texts);
      return texts.map(() => new Float32Array([1, 2, 3]));
    },
  };
}

describe('createEmbeddingProvider', () => {
  it('exposes the model spec metadata', () => {
    const provider = createEmbeddingProvider(
      NOMIC_EMBED_TEXT_V1_5,
      recordingBackend()
    );
    expect(provider.spec).toBe(NOMIC_EMBED_TEXT_V1_5);
    expect(provider.dimensions).toBe(768);
    expect(provider.maxTokens).toBe(8192);
    expect(provider.id).toBe('fake');
    expect(provider.name).toBe('Nomic Embed Text v1.5');
  });

  it('formats queries with the model query formatter', async () => {
    const backend = recordingBackend();
    const provider = createEmbeddingProvider(NOMIC_EMBED_TEXT_V1_5, backend);
    await provider.embedQuery('how do I index');
    expect(backend.seen).toEqual(['search_query: how do I index']);
  });

  it('formats documents with the model document formatter', async () => {
    const backend = recordingBackend();
    const provider = createEmbeddingProvider(NOMIC_EMBED_TEXT_V1_5, backend);
    await provider.embedDocument('a chunk of text');
    expect(backend.seen).toEqual(['search_document: a chunk of text']);
  });

  it('getEmbedding passes text through unformatted', async () => {
    const backend = recordingBackend();
    const provider = createEmbeddingProvider(NOMIC_EMBED_TEXT_V1_5, backend);
    await provider.getEmbedding('raw text');
    expect(backend.seen).toEqual(['raw text']);
  });

  it('throws when the backend returns no vector', async () => {
    const backend: EmbeddingBackend = {
      id: 'empty',
      dtype: 'q8',
      init: async () => {},
      dispose: async () => {},
      embed: async () => [],
    };
    const provider = createEmbeddingProvider(NOMIC_EMBED_TEXT_V1_5, backend);
    await expect(provider.embedQuery('x')).rejects.toThrow(/returned no vector/);
  });
});
