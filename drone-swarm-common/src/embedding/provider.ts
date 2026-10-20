import type {
  DroneEmbeddingModelSpec,
  DroneEmbeddingProvider,
  DroneEmbeddingTask,
} from 'drone-core';

import type { EmbeddingBackend } from './types.js';

/**
 * Wraps a backend in the model-aware provider shape. Query and document text
 * is formatted by the model spec before it reaches the backend, so callers
 * never repeat prefix strings.
 */
export function createEmbeddingProvider(
  spec: DroneEmbeddingModelSpec,
  backend: EmbeddingBackend
): DroneEmbeddingProvider {
  const embedOne = async (text: string): Promise<Float32Array> => {
    const [vector] = await backend.embed([text]);
    if (!vector) {
      throw new Error(
        `Embedding backend "${backend.id}" returned no vector for model "${spec.id}"`
      );
    }
    return vector;
  };

  return {
    id: backend.id,
    name: spec.name,
    spec,
    dimensions: spec.dimensions,
    maxTokens: spec.maxTokens,

    getEmbedding: embedOne,

    embedQuery(
      text: string,
      opts?: { task?: DroneEmbeddingTask }
    ): Promise<Float32Array> {
      return embedOne(spec.formatQuery(text, opts));
    },

    embedDocument(
      text: string,
      opts?: { title?: string }
    ): Promise<Float32Array> {
      return embedOne(spec.formatDocument(text, opts));
    },
  };
}
