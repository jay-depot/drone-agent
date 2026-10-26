import type { DroneEmbeddingModelSpec } from 'drone-core';

import type { EmbeddingBackend } from './types.js';

export type OnnxBackendOptions = {
  dtype?: string;
  device?: string;
  cacheDir?: string;
};

/**
 * The slice of the transformers.js feature-extraction pipeline this backend
 * relies on. The tokenizer and model config are included because `init()`
 * must correct the tokenizer's truncation length (see below).
 */
type FeatureExtractor = {
  (
    texts: string[],
    options: { pooling: 'mean' | 'cls'; normalize: boolean }
  ): Promise<{ data: Float32Array | number[] }>;
  tokenizer?: { model_max_length?: number };
  model?: { config?: { max_position_embeddings?: number } };
};

/**
 * Cap the tokenizer's truncation length at the model's real positional window.
 *
 * WHY THIS EXISTS — it prevents an OOM kill of the whole process:
 *
 * transformers.js' `FeatureExtractionPipeline._call` tokenizes with
 * `{ padding: true, truncation: true }` and passes NO `max_length`. Truncation
 * therefore falls back to the tokenizer's `model_max_length`, which comes from
 * `tokenizer_config.json` — not from the model. For nomic-embed-text-v1.5 those
 * disagree badly:
 *
 *   tokenizer.model_max_length           = 8192
 *   model.config.max_position_embeddings = 2048
 *
 * An 8192-token input therefore reaches a model trained for 2048, and the
 * attention score matrix is quadratic in sequence length:
 *
 *   seq^2 * n_head * 4 bytes = 8192^2 * 12 * 4 = 3.0 GiB
 *
 * That allocation is instant and fatal: on an 8 GB host the beacon (which hosts
 * this backend) is SIGKILLed by earlyoom mid-request, the in-flight
 * `/swarm-memory/retrieve` never responds, and every caller sees "fetch failed".
 *
 * Measured on the input that killed the beacon, in an isolated process:
 *   without this cap: rss 342 -> 4407 MiB (killed)
 *   with this cap:    rss 355 ->  975 MiB, correct 768-dim output
 *
 * `model_max_length` is exposed as a getter with no setter, so a plain
 * assignment throws; defineProperty is required.
 */
function capTokenizerToModelWindow(extractor: FeatureExtractor): void {
  const tokenizer = extractor.tokenizer;
  if (!tokenizer) return;

  const window = extractor.model?.config?.max_position_embeddings;
  const current = tokenizer.model_max_length;

  if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
    return;
  }
  // Nothing to do when the tokenizer is already at or below the real window.
  if (typeof current === 'number' && current <= window) return;

  Object.defineProperty(tokenizer, 'model_max_length', {
    value: window,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

/**
 * In-process ONNX backend. Loads the model through `@huggingface/transformers`
 * (which brings `onnxruntime-node`), so no external daemon is needed.
 *
 * The ONNX runtime has no musl build — this backend needs glibc.
 */
export function createOnnxBackend(
  spec: DroneEmbeddingModelSpec,
  options: OnnxBackendOptions = {}
): EmbeddingBackend {
  const modelId = spec.backends.onnx;
  if (!modelId) {
    throw new Error(
      `Embedding model "${spec.id}" has no ONNX backend; choose another backend or add one to the model spec`
    );
  }

  const dtype = options.dtype ?? 'q8';
  const device = options.device ?? 'cpu';
  const { cacheDir } = options;
  let extractor: FeatureExtractor | undefined;

  return {
    id: 'onnx',
    dtype,

    async init(): Promise<void> {
      const { env, pipeline } = await import('@huggingface/transformers');
      if (cacheDir) {
        env.cacheDir = cacheDir;
      }
      const options = {
        dtype: dtype as 'q8',
        device: device as 'cpu',
      };
      extractor = (await pipeline(
        'feature-extraction',
        modelId,
        options
      )) as unknown as FeatureExtractor;
      capTokenizerToModelWindow(extractor);
    },

    async embed(texts: string[]): Promise<Float32Array[]> {
      if (!extractor) {
        throw new Error(
          `ONNX backend for model "${spec.id}" used before init()`
        );
      }
      const output = await extractor(texts, {
        pooling: spec.pooling,
        normalize: spec.normalize,
      });
      const data = output.data;
      const flat =
        data instanceof Float32Array ? data : Float32Array.from(data);
      const vectors: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 1) {
        vectors.push(
          flat.slice(i * spec.dimensions, (i + 1) * spec.dimensions)
        );
      }
      return vectors;
    },

    async dispose(): Promise<void> {
      extractor = undefined;
    },
  };
}
