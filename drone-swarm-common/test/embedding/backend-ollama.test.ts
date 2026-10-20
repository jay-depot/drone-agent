import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOllamaBackend } from '../../src/embedding/backend-ollama.js';

function mockFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>
): void {
  vi.stubGlobal('fetch', vi.fn(handler));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOllamaBackend', () => {
  it('rejects an over-long host before regexing', () => {
    const longHost = 'x'.repeat(2049);
    expect(() => createOllamaBackend({ host: longHost, model: 'm' })).toThrow(
      /exceeds maximum length/
    );
  });

  it('strips trailing slashes from the host', async () => {
    let seenUrl = '';
    mockFetch(async (url, _init) => {
      seenUrl = url;
      return new Response(JSON.stringify({ embeddings: [[1, 2, 3]] }), {
        status: 200,
      });
    });
    const backend = createOllamaBackend({
      host: 'http://127.0.0.1:11434///',
      model: 'nomic-embed-text:v1.5',
    });
    await backend.embed(['hello']);
    expect(seenUrl).toBe('http://127.0.0.1:11434/api/embed');
  });

  it('posts the model and the full input array', async () => {
    let body: unknown;
    mockFetch(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          embeddings: [
            [1, 2],
            [3, 4],
          ],
        }),
        {
          status: 200,
        }
      );
    });
    const backend = createOllamaBackend({ host: 'http://h', model: 'm1' });
    await backend.embed(['a', 'b']);
    expect(body).toEqual({ model: 'm1', input: ['a', 'b'] });
  });

  it('returns one Float32Array per input', async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            embeddings: [
              [1, 2],
              [3, 4],
            ],
          }),
          {
            status: 200,
          }
        )
    );
    const backend = createOllamaBackend({ host: 'http://h', model: 'm' });
    const vectors = await backend.embed(['a', 'b']);
    expect(vectors).toHaveLength(2);
    expect(Array.from(vectors[0])).toEqual([1, 2]);
    expect(Array.from(vectors[1])).toEqual([3, 4]);
  });

  it('has dtype gguf and id ollama', () => {
    const backend = createOllamaBackend({ host: 'http://h', model: 'm' });
    expect(backend.id).toBe('ollama');
    expect(backend.dtype).toBe('gguf');
  });

  it('throws with the response body on a failed request', async () => {
    mockFetch(async () => new Response('model not found', { status: 404 }));
    const backend = createOllamaBackend({ host: 'http://h', model: 'm' });
    await expect(backend.embed(['a'])).rejects.toThrow(
      /HTTP 404.*model not found/
    );
  });

  it('throws when the response has no embeddings', async () => {
    mockFetch(
      async () =>
        new Response(JSON.stringify({ embeddings: [] }), { status: 200 })
    );
    const backend = createOllamaBackend({ host: 'http://h', model: 'm' });
    await expect(backend.embed(['a'])).rejects.toThrow(/empty embeddings/);
  });
});
