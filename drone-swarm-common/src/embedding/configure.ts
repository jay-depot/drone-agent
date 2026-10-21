import type {
  DroneEmbeddingModelSpec,
  DroneEmbeddingProvider,
} from 'drone-core';
import { getEmbeddingModel, listEmbeddingModelIds } from 'drone-core';

import type { EmbeddingConfig } from '../config-file.js';
import { createOnnxBackend } from './backend-onnx.js';
import { createOllamaBackend } from './backend-ollama.js';
import { indexFingerprint, type EmbeddingIdentity } from './fingerprint.js';
import { createEmbeddingProvider } from './provider.js';
import type { EmbeddingBackend } from './types.js';

const DEFAULT_MODEL_ID = 'nomic-embed-text-v1.5';
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

/**
 * The effective embedding config when the config file has no `embedding`
 * block. `OLLAMA_HOST` is still honoured as a deprecated override for the
 * Ollama backend host.
 */
export function defaultEmbeddingConfig(): EmbeddingConfig {
  const config: EmbeddingConfig = {
    backend: 'onnx',
    model: DEFAULT_MODEL_ID,
    onnx: { dtype: 'q8' },
  };
  const host = process.env.OLLAMA_HOST;
  if (host) {
    config.ollama = { host };
  }
  return config;
}

export type ConfiguredEmbedding = {
  provider: DroneEmbeddingProvider;
  fingerprint: string;
  identity: EmbeddingIdentity;
  dispose(): Promise<void>;
};

function resolveSpec(modelId: string): DroneEmbeddingModelSpec {
  const spec = getEmbeddingModel(modelId);
  if (!spec) {
    throw new Error(
      `Unknown embedding model "${modelId}". Known ids: ${listEmbeddingModelIds().join(', ')}`
    );
  }
  return spec;
}

function createBackend(
  spec: DroneEmbeddingModelSpec,
  config: EmbeddingConfig
): EmbeddingBackend {
  switch (config.backend) {
    case 'onnx':
      return createOnnxBackend(spec, config.onnx ?? {});
    case 'ollama': {
      const modelId = spec.backends.ollama;
      if (!modelId) {
        throw new Error(
          `Embedding model "${spec.id}" has no Ollama backend; choose another backend or add one to the model spec`
        );
      }
      return createOllamaBackend({
        host: config.ollama?.host ?? DEFAULT_OLLAMA_HOST,
        model: modelId,
      });
    }
    default: {
      const unknownBackend: never = config.backend;
      throw new Error(`Unknown embedding backend "${String(unknownBackend)}"`);
    }
  }
}

/**
 * Build, initialise, and return the configured embedding provider. Throws on
 * an unknown model id, an unknown backend, or a backend init failure — the
 * caller must treat any failure as fatal.
 */
export async function createConfiguredEmbeddingProvider(
  config: EmbeddingConfig,
  cacheDir: string
): Promise<ConfiguredEmbedding> {
  const spec = resolveSpec(config.model);
  const backend = createBackend(spec, {
    ...config,
    onnx: { ...config.onnx, cacheDir: config.onnx?.cacheDir ?? cacheDir },
  });

  await backend.init();

  const provider = createEmbeddingProvider(spec, backend);
  const identity: EmbeddingIdentity = {
    modelId: spec.id,
    dimensions: spec.dimensions,
    backend: backend.id,
    dtype: backend.dtype,
  };

  return {
    provider,
    fingerprint: indexFingerprint(identity),
    identity,
    dispose: () => backend.dispose(),
  };
}
