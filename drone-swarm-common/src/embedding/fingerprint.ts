export type EmbeddingIdentity = {
  modelId: string;
  dimensions: number;
  backend: string;
  dtype: string;
};

/**
 * The index fingerprint. Salted into every content hash so that changing any
 * part of the embedding identity forces a full reindex.
 */
export function indexFingerprint(identity: EmbeddingIdentity): string {
  return `${identity.modelId}:${identity.dimensions}:${identity.backend}:${identity.dtype}`;
}
