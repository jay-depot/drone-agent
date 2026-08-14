import type { DroneEmbeddingProvider } from 'drone-core';

// ── Types ───────────────────────────────────────────────────────────

export type OllamaEmbeddingConfig = {
  host: string;
  model?: string;
};

// ── Provider ─────────────────────────────────────────────────────────

export function createOllamaEmbeddingProvider(
  config: OllamaEmbeddingConfig
): DroneEmbeddingProvider {
  // The host comes from config (user/project/beacon/coordinator layers), so
  // bound its length before running the trailing-slash regex to keep the
  // polynomial match from ever seeing unbounded input.
  const rawHost = config.host.trim();
  if (rawHost.length > 2048) {
    throw new Error(
      `Ollama host URL exceeds maximum length: ${rawHost.length}`
    );
  }
  const host = rawHost.replace(/\/+$/, '');
  const model = config.model ?? 'nomic-embed-text:v1.5';

  return {
    id: 'ollama',
    name: `Ollama (${model})`,
    dimensions: 768,
    maxTokens: 8192,

    async getEmbedding(text: string): Promise<Float32Array> {
      const url = `${host}/api/embed`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          input: text,
        }),
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

      // Ollama returns [[...]] — take the first embedding
      const embedding = data.embeddings[0];
      return new Float32Array(embedding);
    },
  };
}
