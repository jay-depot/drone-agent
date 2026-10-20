import type { DroneEmbeddingModelSpec } from 'drone-core';
import { getEmbeddingModel } from 'drone-core';
import {
  createConfiguredEmbeddingProvider,
  type ConfiguredEmbedding,
  type EmbeddingConfig,
} from 'drone-swarm-common';

import {
  getEmbeddingMeta,
  rebuildVecTables,
  setEmbeddingMeta,
} from './db/index.js';
import { logger } from './logger.js';

/** Builds the configured embedding provider. Injectable for testing. */
export type EmbeddingFactory = (
  config: EmbeddingConfig,
  cacheDir: string
) => Promise<ConfiguredEmbedding>;

/**
 * Resolve a canonical model id to its spec. Throws with the known ids listed
 * when the id is unknown, so the beacon can fail fast with a fixable message.
 */
export function resolveEmbeddingSpec(
  config: EmbeddingConfig
): DroneEmbeddingModelSpec {
  const spec = getEmbeddingModel(config.model);
  if (!spec) {
    throw new Error(
      `Unknown embedding model "${config.model}". Set "embedding.model" to a known id.`
    );
  }
  return spec;
}

/**
 * Build the embedding provider and reconcile the stored embedding identity.
 *
 * Fails hard: an unknown model id or a backend that cannot start throws, and
 * the caller exits. There is no fallback backend.
 *
 * When the stored dimensions differ from the new identity, every vector table
 * is rebuilt at the new width and all indexed content is dropped so the next
 * index pass repopulates it.
 */
export async function initEmbedding(
  config: EmbeddingConfig,
  cacheDir: string,
  createProvider: EmbeddingFactory = createConfiguredEmbeddingProvider
): Promise<ConfiguredEmbedding> {
  resolveEmbeddingSpec(config);

  let embedding: ConfiguredEmbedding;
  try {
    embedding = await createProvider(config, cacheDir);
  } catch (err) {
    throw new Error(
      `Embedding provider "${config.backend}" for model "${config.model}" failed to start: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err }
    );
  }

  const storedMeta = getEmbeddingMeta();
  if (storedMeta && storedMeta.dimensions !== embedding.identity.dimensions) {
    logger.info(
      `Embedding dimensions changed (${storedMeta.dimensions} -> ${embedding.identity.dimensions}); rebuilding vector tables`
    );
    rebuildVecTables(embedding.identity.dimensions);
  }
  setEmbeddingMeta(embedding.identity);

  return embedding;
}
