import type { DroneEmbeddingModelSpec } from 'drone-core';

import type { EmbeddingBackend } from './types.js';

export type OnnxBackendOptions = {
  dtype?: string;
  device?: string;
  cacheDir?: string;
};

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean' | 'cls'; normalize: boolean }
) => Promise<{ data: Float32Array | number[] }>;

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
