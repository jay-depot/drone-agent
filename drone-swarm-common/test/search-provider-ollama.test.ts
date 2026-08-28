import { describe, expect, it } from 'vitest';
import { createOllamaEmbeddingProvider } from '../src/search-provider-ollama.js';

describe('createOllamaEmbeddingProvider', () => {
  it('strips trailing slashes from the host', () => {
    const provider = createOllamaEmbeddingProvider({
      host: 'http://localhost:11434///',
    });
    expect(provider.id).toBe('ollama');
    expect(provider.name).toBe('Ollama (nomic-embed-text:v1.5)');
  });

  it('rejects an over-long host before running the trailing-slash regex', () => {
    const longHost = `http://localhost:11434/${'a'.repeat(4096)}`;
    expect(() => createOllamaEmbeddingProvider({ host: longHost })).toThrow(
      /exceeds maximum length/
    );
  });

  it('accepts a host at the length limit', () => {
    const host = `http://localhost:11434/${'a'.repeat(2000)}`;
    const provider = createOllamaEmbeddingProvider({ host });
    expect(provider.id).toBe('ollama');
  });
});
