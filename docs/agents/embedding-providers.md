# Embedding Providers

The beacon builds all semantic-search vectors. It runs one embedding provider,
chosen by the `embedding` block in the beacon config file.

## Backends

| Backend  | How it runs                                 | Default |
| -------- | ------------------------------------------- | ------- |
| `onnx`   | In-process, via `@huggingface/transformers` | **yes** |
| `ollama` | A running Ollama daemon                     | no      |

The ONNX backend is the default. No second process is needed. The first start
downloads the model (about 137 MB for Nomic Embed Text v1.5) into
`<configDir>/embedding-models`.

The ONNX runtime needs **glibc**. It has no musl build. Beacon-starting Docker
images therefore use `node:22-slim`, not `node:22-alpine`.

## Config

```jsonc
{
  "embedding": {
    "backend": "onnx",
    "model": "nomic-embed-text-v1.5",
    "ollama": { "host": "http://127.0.0.1:11434" },
    "onnx": {
      "dtype": "q8",
      "device": "cpu",
      "cacheDir": "/var/lib/drone-beacon/embedding-models",
    },
  },
}
```

- `model` is a **canonical model id**, never a backend tag. A tag lives only in
  the model spec's `backends` map.
- `OLLAMA_HOST` is a **deprecated** override. It feeds only the default config
  when the config file has no `embedding` block.
- Absent `embedding` block = `{ backend: 'onnx', model: 'nomic-embed-text-v1.5', onnx: { dtype: 'q8' } }`.

## Failure is fatal

A backend that cannot start stops the beacon. There is no fallback. An unknown
model id also stops the beacon, with the known ids in the message. Fix the
`embedding` block and restart.

## The model registry

The model facts live in `drone-core/src/embedding-models.ts`. One
`DroneEmbeddingModelSpec` holds the dimensions, the pooling mode, the token
limit, the per-backend model identifiers, and two functions:

- `formatQuery(text, opts?)`
- `formatDocument(text, opts?)`

The functions exist because a model can need more than a constant prefix. A
model such as EmbeddingGemma interpolates a title and selects among task
templates. A plain prefix constant cannot describe it.

Add a model by adding one registry entry. No other file changes.

**Invariant:** a change to any spec field that changes the produced vectors
(`pooling`, `normalize`) **must** get a new `id`. The id is salted into the
index fingerprint, so a new id forces a full reindex. Without the new id, a
change would silently mix old and new vectors.

## The index fingerprint

The fingerprint is `model_id` + `dimensions` + `backend` + `dtype`. It is
salted into every content hash (workspace files and wiki pages). Any change to
the embedding identity therefore makes every stored hash stale, and the next
index pass rebuilds the whole index. The beacon also stores the identity in a
single-row `embedding_meta` table. If the dimensions change, the beacon drops
and recreates the `vec0` tables at the new width and clears all indexed
content.

## Provider shape

`DroneEmbeddingProvider` (`drone-core/src/capabilities.ts`) has:

- `spec` — the model descriptor.
- `getEmbedding(text)` — raw text, no formatting.
- `embedQuery(text, opts?)` — formats the text as a query.
- `embedDocument(text, opts?)` — formats the text as a document.
- `dimensions`, `maxTokens`, `id`, `name`.

Callers never repeat a prefix string. The indexers call `embedDocument`; the
search routes call `embedQuery`.

## Code layout

| Path                                                 | Role                                            |
| ---------------------------------------------------- | ----------------------------------------------- |
| `drone-core/src/embedding-models.ts`                 | The registry and the spec type                  |
| `drone-swarm-common/src/embedding/types.ts`          | The `EmbeddingBackend` seam                     |
| `drone-swarm-common/src/embedding/backend-onnx.ts`   | The in-process ONNX backend                     |
| `drone-swarm-common/src/embedding/backend-ollama.ts` | The Ollama backend                              |
| `drone-swarm-common/src/embedding/provider.ts`       | Wraps a backend in the provider shape           |
| `drone-swarm-common/src/embedding/fingerprint.ts`    | The index fingerprint                           |
| `drone-swarm-common/src/embedding/configure.ts`      | Resolves the spec and builds the provider       |
| `drone-beacon/src/embedding-init.ts`                 | Startup wiring + the `embedding_meta` reconcile |

See ADR 259 for the decision record.
