# 259. Embedding model registry and removal of the Ollama requirement

- Status: Accepted
- Date: 2026-10-20

## Context

The beacon needed a running Ollama daemon to make vectors for semantic search.
One function made those vectors (`createOllamaEmbeddingProvider`), and the
beacon instantiated it directly. Two problems followed.

1. **A second process was required.** The beacon could not embed without Ollama.
2. **The model facts were scattered.** Four files hardcoded the Nomic prefix
   strings (`search_document:` in `search-indexer.ts` and `wiki-indexer.ts`,
   `search_query:` in `routes/search.ts` and `routes/wiki.ts`), and the
   dimension `768` was hardcoded in the `vec0` DDL. A second model was therefore
   a four-file edit, and the model name could drift from the installed tag.

Research found that only some models need more than a constant prefix pair. A
model such as EmbeddingGemma interpolates a title and selects among task
templates, so a plain prefix constant cannot describe it. This settled the
shape: the model must own functions, not constants.

Two indexer bugs also blocked the work, because a model change forces a
reindex:

- **Bug A** — both indexers wrote the content hash _before_ embedding. A failed
  embed left the unit marked as indexed, so a later reindex did nothing.
- **Bug B** — the wiki indexer's changed-content path inserted chunks with no
  prior delete, so a changed page doubled its chunks.

## Decision

**D1 — The backend is a config switch.** The in-process ONNX backend
(`@huggingface/transformers`) is the new **default**. Ollama stays as an
optional backend. The beacon no longer needs a second process.

**D2 — The model registry lives in `drone-core`.** A
`DroneEmbeddingModelSpec` (`drone-core/src/embedding-models.ts`) carries the
model facts (`id`, `name`, `dimensions`, `maxTokens`, `asymmetric`,
`supportsTitle`, `pooling`, `normalize`, `tasks`, `backends`) plus
`formatQuery(text, opts?)` and `formatDocument(text, opts?)`. The provider
(`DroneEmbeddingProvider`) gains `spec`, `embedQuery`, and `embedDocument`. The
backends live in `drone-swarm-common/src/embedding/` behind an
`EmbeddingBackend` seam (`id`, `dtype`, `init`, `embed`, `dispose`).

**INVARIANT:** a change to any spec field that changes the produced vectors
(for example `pooling` or `normalize`) **must** get a new `id`. The id is
salted into the index fingerprint, so a new id forces a full reindex.

**D3 — Selection is one beacon-global `embedding` block.** The value of
`model` is a **canonical model id**, never a backend tag. A tag lives only in
`spec.backends`. `OLLAMA_HOST` stays as a deprecated override that feeds only
`defaultEmbeddingConfig()`.

```jsonc
{
  "embedding": {
    "backend": "onnx",
    "model": "nomic-embed-text-v1.5",
    "ollama": { "host": "http://127.0.0.1:11434" },
    "onnx": {
      "dtype": "q8",
      "device": "cpu",
      "cacheDir": "/home/openhabian/.drone-beacon/embedding-models",
    },
  },
}
```

**D4 — The index fingerprint.** The fingerprint is
`model_id` + `dimensions` + `backend` + `dtype`
(`indexFingerprint` in `drone-swarm-common/src/embedding/fingerprint.ts`). It
is salted into every content hash (file and wiki page), so **any** change to
the embedding identity makes a full reindex. The beacon also stores the
identity in a single-row `embedding_meta` table.

**D5 — A backend failure stops beacon startup.** There is no fallback. The
model download happens at startup, so the failure is early and clear. The cache
directory is `<configDir>/embedding-models`. The ONNX module is imported
dynamically, so a beacon that selects Ollama never loads it.

**D6 — The dead embedding surface is deleted.** `DroneSearchCapability`,
`DroneSearchConfig.userEmbeddingProvider`,
`DroneSearchConfig.projectEmbeddingProvider`, and
`DroneSearchPath.embeddingProvider` are removed.

**D7 — The two indexer bugs are fixed.** Both indexers embed every chunk
first, then write the chunks and the hash in **one transaction**. The wiki
indexer skips a page only when the hash matches **and** the chunk count is
greater than zero.

## Consequences

- The beacon runs as one process. The default startup downloads about 137 MB
  into `<configDir>/embedding-models`; it needs network on first run.
- `@huggingface/transformers` pulls `onnxruntime-node` (about 300 MB across all
  platforms; only the matching binary loads). The install grows.
- The ONNX runtime needs glibc. There is no musl build, so beacon-starting
  Docker images move from `node:22-alpine` to `node:22-slim`. The coordinator
  and agent images do not embed and can stay Alpine.
- A model change forces a full reindex. This is intended: the fingerprint
  guarantees that stale vectors can never be mixed with new ones.
- A new model is one registry entry, not four edited files.
- The dimension is no longer hardcoded. `initDatabase(dataPath, dimensions)`
  and `rebuildVecTables(dimensions)` accept the model's width.

## Removed

- `DroneSearchCapability` (type).
- `DroneSearchConfig.userEmbeddingProvider`, `.projectEmbeddingProvider`.
- `DroneSearchPath.embeddingProvider`.
- `drone-swarm-common/src/search-provider-ollama.ts` (replaced by the
  `embedding/` module).

## Deferred

- Shipping EmbeddingGemma 2 as a registry entry. The registry makes it
  possible; this decision does not do it.
- Request-level role parameters for remote embedding APIs (for example Cohere
  `input_type`). This belongs on the backend seam, not the model spec.
- A model-menu slash command or TUI surface.
- Making the wiki reindex route asynchronous.

## Related

- [251-enabledplugins-override-map-and-server-merge](251-enabledplugins-override-map-and-server-merge.md)
- [245-search-path-rag-sources](245-search-path-rag-sources.md)
- modules/drone-beacon.md
- modules/drone-core.md
