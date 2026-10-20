export type DroneEmbeddingTask =
  | 'search_query'
  | 'search_document'
  | 'question_answering'
  | 'fact_checking'
  | 'code_retrieval'
  | 'classification'
  | 'clustering'
  | 'sentence_similarity';

export type DroneEmbeddingModelSpec = {
  /** Canonical model id. Config refers to this, never to a backend tag. */
  id: string;
  name: string;
  dimensions: number;
  maxTokens: number;
  /** True when queries and documents get different formatting. */
  asymmetric: boolean;
  /** True when `formatDocument` accepts a title. */
  supportsTitle: boolean;
  pooling: 'mean' | 'cls';
  normalize: boolean;
  tasks: DroneEmbeddingTask[];
  /** Backend id → model identifier used by that backend. */
  backends: Record<string, string>;
  formatQuery(text: string, opts?: { task?: DroneEmbeddingTask }): string;
  formatDocument(text: string, opts?: { title?: string }): string;
};

/**
 * Nomic Embed Text v1.5.
 *
 * INVARIANT: any change to a field that alters the produced vectors (for
 * example `pooling` or `normalize`) MUST get a new `id`. The id is salted into
 * the index fingerprint, so a new id forces a full reindex.
 */
export const NOMIC_EMBED_TEXT_V1_5: DroneEmbeddingModelSpec = {
  id: 'nomic-embed-text-v1.5',
  name: 'Nomic Embed Text v1.5',
  dimensions: 768,
  maxTokens: 8192,
  asymmetric: true,
  supportsTitle: false,
  pooling: 'mean',
  normalize: true,
  tasks: ['search_query', 'search_document', 'classification', 'clustering'],
  backends: {
    ollama: 'nomic-embed-text:v1.5',
    onnx: 'nomic-ai/nomic-embed-text-v1.5',
  },
  formatQuery: text => `search_query: ${text}`,
  formatDocument: text => `search_document: ${text}`,
};

export const EMBEDDING_MODELS: DroneEmbeddingModelSpec[] = [
  NOMIC_EMBED_TEXT_V1_5,
];

export function getEmbeddingModel(
  id: string
): DroneEmbeddingModelSpec | undefined {
  return EMBEDDING_MODELS.find(model => model.id === id);
}

export function listEmbeddingModels(): DroneEmbeddingModelSpec[] {
  return [...EMBEDDING_MODELS];
}

export function listEmbeddingModelIds(): string[] {
  return EMBEDDING_MODELS.map(model => model.id);
}
