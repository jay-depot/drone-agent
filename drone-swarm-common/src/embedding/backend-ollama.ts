import type { EmbeddingBackend } from './types.js';

export type OllamaBackendConfig = {
  host: string;
  model: string;
};

const MAX_HOST_LENGTH = 2048;

/**
 * Ollama backend. Expects raw text — formatting is the provider's job.
 */
export function createOllamaBackend(
  config: OllamaBackendConfig
): EmbeddingBackend {
  // The host comes from config (user/project/beacon/coordinator layers), so
  // bound its length before running the trailing-slash regex to keep the
  // polynomial match from ever seeing unbounded input.
  const rawHost = config.host.trim();
  if (rawHost.length > MAX_HOST_LENGTH) {
    throw new Error(
      `Ollama host URL exceeds maximum length: ${rawHost.length}`
    );
  }
  const host = rawHost.replace(/\/+$/, '');
  const { model } = config;

  return {
    id: 'ollama',
    dtype: 'gguf',

    async init(): Promise<void> {
      // Ollama loads the model on first request; nothing to do here.
    },

    async embed(texts: string[]): Promise<Float32Array[]> {
      const url = `${host}/api/embed`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Ollama embedding request failed (HTTP ${response.status}): ${body || response.statusText}`
        );
      }

      const data = (await response.json()) as {
        embeddings?: number[][];
      };

      if (!data.embeddings || data.embeddings.length === 0) {
        throw new Error(
          `Ollama embedding returned empty embeddings for model ${model}`
        );
      }

      return data.embeddings.map(embedding => new Float32Array(embedding));
    },

    async dispose(): Promise<void> {
      // No local resources to release.
    },
  };
}
