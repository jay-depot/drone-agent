/**
 * A concrete embedding implementation that turns raw text into vectors. The
 * backend knows nothing about the model's formatting rules — the provider
 * applies those before calling {@link EmbeddingBackend.embed}.
 */
export interface EmbeddingBackend {
  readonly id: string;
  /** Quantisation/precision marker used in the index fingerprint. */
  readonly dtype: string;
  init(): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}
