import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initEmbedding, resolveEmbeddingSpec } from '../src/embedding-init.js';
import {
  getEmbeddingMeta,
  setEmbeddingMeta,
  upsertFile,
  insertChunk,
  getFileHash,
} from '../src/db/index.js';
import type { ConfiguredEmbedding } from 'drone-swarm-common';
import { NOMIC_EMBED_TEXT_V1_5 } from 'drone-core';
import { setupDb, teardownDb } from './setup.js';

function stubEmbedding(dimensions: number): ConfiguredEmbedding {
  return {
    provider: {
      id: 'stub',
      name: 'Stub',
      spec: NOMIC_EMBED_TEXT_V1_5,
      dimensions,
      maxTokens: 8192,
      getEmbedding: async () => new Float32Array(dimensions),
      embedQuery: async () => new Float32Array(dimensions),
      embedDocument: async () => new Float32Array(dimensions),
    },
    fingerprint: `stub:${dimensions}:test:q8`,
    identity: {
      modelId: 'stub',
      dimensions,
      backend: 'test',
      dtype: 'q8',
    },
    dispose: async () => {},
  };
}

describe('resolveEmbeddingSpec', () => {
  it('resolves a known canonical model id', () => {
    const spec = resolveEmbeddingSpec({
      backend: 'onnx',
      model: 'nomic-embed-text-v1.5',
    });
    expect(spec.id).toBe('nomic-embed-text-v1.5');
  });

  it('throws for an unknown model id', () => {
    expect(() =>
      resolveEmbeddingSpec({ backend: 'onnx', model: 'nope' })
    ).toThrow(/Unknown embedding model "nope"/);
  });
});

describe('initEmbedding', () => {
  beforeEach(async () => {
    await setupDb();
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('writes the embedding meta row', async () => {
    const factory = vi.fn(async () => stubEmbedding(768));
    await initEmbedding(
      { backend: 'onnx', model: 'nomic-embed-text-v1.5' },
      '/tmp/models',
      factory
    );
    expect(factory).toHaveBeenCalledOnce();
    expect(getEmbeddingMeta()?.dimensions).toBe(768);
    expect(getEmbeddingMeta()?.backend).toBe('test');
  });

  it('rebuilds the vector tables when the dimensions change', async () => {
    setEmbeddingMeta({
      modelId: 'stub',
      dimensions: 768,
      backend: 'test',
      dtype: 'q8',
    });
    upsertFile('/dir', '/dir/a.ts', 'old-hash');
    insertChunk('/dir', '/dir/a.ts', 0, 'chunk', new Float32Array(768));

    await initEmbedding(
      { backend: 'onnx', model: 'nomic-embed-text-v1.5' },
      '/tmp/models',
      async () => stubEmbedding(1024)
    );

    expect(getEmbeddingMeta()?.dimensions).toBe(1024);
    expect(getFileHash('/dir', '/dir/a.ts')).toBeUndefined();
  });

  it('does not rebuild when the dimensions are unchanged', async () => {
    setEmbeddingMeta({
      modelId: 'stub',
      dimensions: 768,
      backend: 'test',
      dtype: 'q8',
    });
    upsertFile('/dir', '/dir/a.ts', 'same-hash');
    insertChunk('/dir', '/dir/a.ts', 0, 'chunk', new Float32Array(768));

    await initEmbedding(
      { backend: 'onnx', model: 'nomic-embed-text-v1.5' },
      '/tmp/models',
      async () => stubEmbedding(768)
    );

    expect(getFileHash('/dir', '/dir/a.ts')).toBe('same-hash');
  });

  it('propagates a provider failure so the beacon can exit', async () => {
    await expect(
      initEmbedding(
        { backend: 'onnx', model: 'nomic-embed-text-v1.5' },
        '/tmp/models',
        async () => {
          throw new Error('no network');
        }
      )
    ).rejects.toThrow(/failed to start: no network/);
  });
});
