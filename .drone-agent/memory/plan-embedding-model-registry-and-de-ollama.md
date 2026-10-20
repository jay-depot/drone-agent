---
key: plan-embedding-model-registry-and-de-ollama
tags:
  - plan
  - embeddings
  - drone-core
  - drone-swarm-common
  - drone-beacon
  - ollama
  - onnx
  - transformers-js
  - model-registry
  - semantic-search
  - reindex
created: 2026-10-20T22:13:11.229Z
updated: 2026-10-20T22:13:11.229Z
---

---

# Plan: Embedding Model Registry + Removal of the Ollama Requirement

**Status**: ready for execution. Next ADR number = 259.

## 1. Summary

Today the beacon needs a running Ollama daemon to make vectors for semantic search. One function makes those vectors. Later, a second requirement appears: the model registry must let us offer more embedding models.

This plan does two things. They are separate, but they meet at one config line.

Part 1 - Remove the Ollama requirement. Add an in-process ONNX backend. Make it the default. Keep Ollama as a selectable backend. The beacon no longer needs a separate daemon.

Part 2 - Centralise the prefix logic. Today four files hardcode the Nomic prefix strings. Move the model facts and the text formatting into one registry in `drone-core`. Then a new model is one registry entry, not four edited files.

Why: one process, not two. One place holds the model name, so it cannot drift from the installed name. A new model becomes a menu item, not a code change.

## 2. Scope

### In scope

- Add a model descriptor registry in `drone-core`.
- Add an ONNX backend. Add an Ollama backend that uses the same provider shape.
- Add the `embedding` block to the beacon config file.
- Add the `embedding_meta` table. Salt the content hash with the model identity.
- Fix two indexer bugs. Both block this feature.
- Delete the dead embedding config fields and the dead `DroneSearchCapability`.
- Write tests, docs, and ADR 259.

### Out of scope

- Adding EmbeddingGemma 2 as a shipped model (the registry makes it possible; this plan does not do it).
- Request-level role parameters for remote APIs (example: Cohere `input_type`).
- Changing the chunker, the `sqlite-vec` storage, or the bit-signature prefilter (ADR 181).

## 3. Locked decisions

| #   | Decision                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | The backend is a config switch. The in-process ONNX backend is the new default. Ollama stays as an optional backend.                                                                           |
| D2  | The model descriptor registry and the formatter functions live in `drone-core`. The provider gains `embedQuery` and `embedDocument`. The backends live in `drone-swarm-common/src/embedding/`. |
| D3  | Selection is one beacon-global `embedding` block in the beacon config file. The value is a canonical model id, not a tag. `OLLAMA_HOST` stays as a deprecated override.                        |
| D4  | The fingerprint is `model_id` + `dimensions` + `backend` + `dtype`. Salt the content hash with the fingerprint. Then a model change always makes a full reindex.                               |
| D5  | A backend failure stops beacon startup. It does not fall back. The model download happens at startup. The cache directory is under the beacon config directory.                                |
| D6  | Delete all dead embedding surface: `DroneSearchCapability`, `DroneSearchConfig.userEmbeddingProvider`, `DroneSearchConfig.projectEmbeddingProvider`, `DroneSearchPath.embeddingProvider`.      |

## 4. Interfaces

### 4.1 The model descriptor

File: `drone-core/src/embedding-models.ts` (new).

```ts
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
  id: string; // canonical id; config uses this
  name: string;
  dimensions: number;
  maxTokens: number;
  asymmetric: boolean;
  supportsTitle: boolean;
  pooling: 'mean' | 'cls';
  normalize: boolean;
  tasks: DroneEmbeddingTask[];
  backends: Record<string, string>; // { ollama: 'nomic-embed-text:v1.5', onnx: 'Xenova/nomic-embed-text-v1.5' }
  formatQuery(text: string, opts?: { task?: DroneEmbeddingTask }): string;
  formatDocument(text: string, opts?: { title?: string }): string;
};

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
    onnx: 'Xenova/nomic-embed-text-v1.5',
  },
  formatQuery: text => `search_query: ${text}`,
  formatDocument: text => `search_document: ${text}`,
};

export const EMBEDDING_MODELS: DroneEmbeddingModelSpec[] = [
  NOMIC_EMBED_TEXT_V1_5,
];
export function getEmbeddingModel(
  id: string
): DroneEmbeddingModelSpec | undefined;
export function listEmbeddingModels(): DroneEmbeddingModelSpec[];
```

INVARIANT: a change to any part of a spec that changes the vectors (example: `pooling`, `normalize`) MUST get a new `id`.

### 4.2 The provider

File: `drone-core/src/capabilities.ts`. Change `DroneEmbeddingProvider` to add `spec: DroneEmbeddingModelSpec`, `embedQuery(text, opts?)`, `embedDocument(text, opts?)`. Add the new types to the `drone-core/src/index.ts` barrel.

### 4.3 The fingerprint

File: `drone-swarm-common/src/embedding/fingerprint.ts` (new).

```ts
export type EmbeddingIdentity = {
  modelId: string;
  dimensions: number;
  backend: string;
  dtype: string;
};
export function indexFingerprint(identity: EmbeddingIdentity): string {
  return `${identity.modelId}:${identity.dimensions}:${identity.backend}:${identity.dtype}`;
}
```

### 4.4 The backend seam

File: `drone-swarm-common/src/embedding/types.ts` (new).

```ts
export interface EmbeddingBackend {
  readonly id: string;
  readonly dtype: string; // 'q8' for onnx; 'gguf' for ollama
  init(): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}
```

### 4.5 The config block

File: `drone-swarm-common/src/config-file.ts`.

```ts
export type EmbeddingBackendId = 'onnx' | 'ollama';
export type EmbeddingConfig = {
  backend: EmbeddingBackendId;
  model: string; // canonical model id
  ollama?: { host?: string };
  onnx?: { dtype?: string; device?: string; cacheDir?: string };
};
```

Add `embedding?: EmbeddingConfig` to `ServerConfigFile`. Add `'embedding'` to `ALLOWED_KEYS`. Add `validateEmbedding` (reject an unknown backend, an empty model, a non-object sub-block).

Config example:

```jsonc
{
  "spawnRoots": {
    "paths": ["/home/openhabian/"],
    "default": "/home/openhabian/",
  },
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

### 4.6 The embedding_meta table

```sql
CREATE TABLE IF NOT EXISTS embedding_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  backend TEXT NOT NULL,
  dtype TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## 5. Steps

### Phase A - The registry (drone-core)

A1 (coder) - Add `drone-core/src/embedding-models.ts` with the code in 4.1. Dep: none.
A2 (coder) - Change `DroneEmbeddingProvider` in `drone-core/src/capabilities.ts` (add `spec`, `embedQuery`, `embedDocument`). Import the descriptor types. Update the `drone-core/src/index.ts` barrel. Dep: A1.
A3 (coder) - Delete the `DroneSearchCapability` type from `drone-core/src/capabilities.ts` and from `drone-core/src/index.ts`. Keep `SearchResult` and `IndexResult`. Dep: none.
A4 (coder) - Delete `DroneSearchPath.embeddingProvider` (config-types.ts:13), `DroneSearchConfig.userEmbeddingProvider`/`.projectEmbeddingProvider` (config-types.ts:36-37), their entries in config-schema.ts:346,368-369, and `'search.userEmbeddingProvider'`/`'search.projectEmbeddingProvider'` from KNOWN_CONFIG_KEYS (config-keys.ts:79-80). Dep: none.
A5 (coder) - Run `pnpm --filter drone-core build`. Dep: A1-A4.
A6 (tester) - New `drone-core/test/embedding-models.test.ts`: registry lookup, unknown id -> undefined, formatQuery/formatDocument output, listEmbeddingModels returns a copy. Dep: A1.

### Phase B - The backends (drone-swarm-common)

B1 (coder) - New `drone-swarm-common/src/embedding/types.ts` (4.4) and `.../provider.ts` with `createEmbeddingProvider(spec, backend)` returning a `DroneEmbeddingProvider` whose `embedQuery`/`embedDocument` call `spec.formatQuery`/`spec.formatDocument` then `backend.embed([...])[0]`. Dep: A2.
B2 (coder) - New `.../embedding/fingerprint.ts` (4.3). Dep: none.
B3 (coder) - New `.../embedding/backend-ollama.ts`; DELETE `drone-swarm-common/src/search-provider-ollama.ts`. Keep the host length check and the trailing-slash strip. `createOllamaBackend({host, model})` returns an `EmbeddingBackend`; `embed` POSTs `{host}/api/embed` with `{model, input: texts}`; `dtype` is the fixed string `gguf`. Dep: B1.
B4 (coder) - New `.../embedding/backend-onnx.ts` with `createOnnxBackend(spec, {dtype?, device?, cacheDir?})`; dynamic `import('@huggingface/transformers')`; set `env.cacheDir`; `pipeline('feature-extraction', spec.backends.onnx, { dtype, device })`; `embed` calls the extractor with `{ pooling: spec.pooling, normalize: spec.normalize }` and wraps `result.data` in a Float32Array; `dtype` default 'q8', `device` default 'cpu'; throw if the spec has no `onnx` backend. Dep: B1.
B5 (coder) - New `.../embedding/configure.ts`: `defaultEmbeddingConfig()` returns `{ backend: 'onnx', model: 'nomic-embed-text-v1.5', onnx: { dtype: 'q8' } }` and reads `OLLAMA_HOST` into `ollama.host`; `createConfiguredEmbeddingProvider(cfg, cacheDir)` resolves the spec (clear error listing known ids on unknown id), builds the backend (error on unknown backend), calls `backend.init()`, returns `{ provider, fingerprint, identity }`. Dep: B1-B4.
B6 (coder) - New `.../embedding/index.ts` barrel. In `drone-swarm-common/src/index.ts` add `export * from './embedding/index.js';` and remove the `./search-provider-ollama.js` line. Add `@huggingface/transformers` to `drone-swarm-common/package.json` dependencies. Dep: B1-B5.
B7 (tester) - New tests: `test/embedding/fingerprint.test.ts`, `test/embedding/provider.test.ts`, `test/embedding/backend-ollama.test.ts` (replaces `search-provider-ollama.test.ts`); update `test/config-file.test.ts` for `embedding` validation. Dep: B1-B6.

### Phase C - The database (drone-beacon)

C1 (coder) - New `drone-beacon/src/db/embedding-meta.ts`: `getEmbeddingMeta`, `setEmbeddingMeta`, `rebuildVecTables(dimensions)`. `rebuildVecTables` drops+recreates `vec_chunks`, `vec_chunks_bq`, `wiki_vec_chunks` at the new dimension AND clears `search_chunks`, `search_files`, `wiki_chunks`, `wiki_sources`. Add the `embedding_meta` DDL from 4.6 in `db/init.ts`. Export from `db/index.ts`. Dep: none.
C2 (coder) - `db/init.ts`: `initDatabase(dbPath, dimensions)`; use the parameter in the three `vec0` statements; remove the hardcoded 768. Dep: C1.
C3 (coder) - `db/wiki-chunks.ts`: change `replaceWikiChunks` to `replaceWikiPage(pageId, origin, {title, updatedAt, hash}, chunks)` doing the source upsert + all chunk inserts in one transaction, deleting the old chunks first. Update references. Dep: none.
C4 (tester) - New `test/embedding-meta.test.ts` + update `test/wiki-chunks.test.ts`: meta round-trip; `rebuildVecTables(1024)` accepts 1024-d vectors; `replaceWikiPage` replaces and does not append. Dep: C1, C3.

### Phase D - The indexers (drone-beacon)

D1 (coder) - `src/search-indexer.ts`: add `fingerprint` to the constructor; `computeFileHash(filePath, fingerprint)` = `sha256(fingerprint + '\0' + content)`; reorder so ALL chunks are embedded first, then ONE transaction deletes the old chunks, inserts the new chunks, and writes the file hash; replace line 122 `provider.getEmbedding(`search_document: ${chunks[i]}`)` with `provider.embedDocument(chunks[i])`. Dep: B1, C2.
D2 (coder) - `src/wiki-indexer.ts`: add `fingerprint` to the constructor; `pageHash` = `sha256(fingerprint + '\0' + pageId + '\0' + origin + '\0' + updatedAt + '\0' + content)`; skip only when the hash matches AND the chunk count > 0 (use `db.getWikiSourcesWithChunkCounts()`); reorder to embed all chunks first then call `db.replaceWikiPage(...)`; replace line 169 `provider.getEmbedding(`search_document: ${text}`)` with `provider.embedDocument(text, { title: entry.page.title })`. Dep: B1, C3.
D3 (coder) - `src/routes/search.ts:154` and `src/routes/wiki.ts:287`: `provider.getEmbedding(`search_query: ${q}`)` -> `provider.embedQuery(q)`. Dep: B1.
D4 (tester) - Update `test/wiki-indexer.test.ts` + `test/search-indexer.test.ts`. Tests: (a) changed page reindex does NOT double the chunk count; (b) a throwing embedding leaves NO source/file hash and a later reindex works; (c) same for a workspace file. Update every provider mock with `spec`/`embedQuery`/`embedDocument`. Dep: D1-D3.

### Phase E - Beacon wiring (drone-beacon)

E1 (coder) - `src/index.ts`: read `config.embedding` (apply `defaultEmbeddingConfig()` when absent); resolve the spec; `initDatabase(config.dbPath, spec.dimensions)`; `createConfiguredEmbeddingProvider(cfg, path.join(config.configDir, 'embedding-models'))`; on error log the cause + the fix and `process.exit(1)` (NO fallback); compare identity with `getEmbeddingMeta()`, `rebuildVecTables` when dimensions differ, `setEmbeddingMeta`; pass provider+fingerprint to `SearchIndexer` and `WikiIndexer`; delete the two `createOllamaEmbeddingProvider` calls and the `OLLAMA_HOST` read (keep `OLLAMA_HOST` only inside `defaultEmbeddingConfig()`). Dep: B5, C1, C2, D1, D2.
E2 (tester) - New `test/embedding-wiring.test.ts`: unknown model id throws; a dimension change calls `rebuildVecTables`; a provider failure does not start the beacon. Dep: E1.

### Phase F - Cleanup, docs, ADR

F1 (coder) - Sweep every implementer and mock. Run `lsp__find_references` on `DroneEmbeddingProvider`, `createOllamaEmbeddingProvider`, `DroneSearchCapability`; text-search `embeddingProvider` and `makeProvider`. Update every site. Dep: A2-A4, B3.
F2 (docs) - Write `docs/adr/259-embedding-model-registry-and-de-ollama.md` (D1-D6, the config shape, the fingerprint rule, the removed dead surface, the spec-id invariant). Add the row to `docs/adr/index.md`. Dep: none.
F3 (docs) - Update `README.md` (remove "ollama is required for embeddings"; document the `embedding` block, the model menu, the hard-fail rule) and `docs/agents/` (new or updated embedding-providers doc). Dep: F2.
F4 (coder) - `docker/smoke-test.Dockerfile` and any other beacon-starting image: change the base from `node:22-alpine` to `node:22-slim` (the ONNX runtime has no musl build). The coordinator and agent images do not embed and can stay Alpine. Dep: none.
F5 (docs) - Update the wiki pages `beacon-semantic-search`, `beacon-wiki-vector-index`, `drone-agent-node-only-embedding-providers`, and the two 2026-10-13 bug pages (mark fixed). Dep: D1-D3.

### Phase G - Acceptance and validation

G1 (tester) - Manual acceptance: (1) start the beacon with `embedding.backend = "onnx"`; it downloads about 137 MB into `<configDir>/embedding-models` and writes the meta row; (2) `search__text mode:"semantic"` returns results with NO ollama process running; (3) change `embedding.model` to a second registry id and restart -> vectors rebuild; (4) change `embedding.backend` to `"ollama"` and restart -> vectors rebuild; (5) a bad model id stops the beacon with a clear message; (6) `wiki_sources` rows with no chunks fall to about zero. Dep: E1.
G2 (reviewer) - Check every item in section 7. Fix until all pass. Dep: all.

## 6. Order and dependencies

- A1, B2, C1, F2, F4 start in parallel.
- A5 needs A1-A4. A6 needs A1. B1 needs A2. B3/B4 need B1. B5 needs B1-B4. B6 needs B1-B5. B7 needs B1-B6.
- C2/C3 need C1. C4 needs C1,C3. D1 needs B1,C2. D2 needs B1,C3. D3 needs B1. D4 needs D1-D3.
- E1 needs B5,C1,C2,D1,D2. E2 needs E1. F1 needs A2-A4,B3. G2 is last.
- Recommended order: A -> B -> C -> D -> E -> F -> G.

## 7. Validation criteria

1. LSP: `lsp__get_diagnostics` shows zero errors and zero warnings for the whole workspace, tests included.
2. Build: `pnpm -r run build` passes with zero errors (run after every drone-core / drone-swarm-common change; dependents read built `dist/`).
3. Typecheck: `pnpm typecheck` passes.
4. Lint: `pnpm run lint` passes with zero errors. This is the project lint process. Prettier rewrites files; re-read files before the next edit.
5. Fast tests: `pnpm run test` passes.
6. New tests exist for the registry (A6), the embedding module (B7), the database changes (C4), the indexer fixes (D4), and the wiring (E2).
7. Bug A fixed: an embedding failure writes no hash (proven for both indexers in D4).
8. Bug B fixed: a reindex of a changed page does not double the chunk count.
9. No dead code: `DroneSearchCapability`, `search.userEmbeddingProvider`, `search.projectEmbeddingProvider`, `DroneSearchPath.embeddingProvider` gone. No fluff comments. Files under 750 lines.
10. Acceptance: the G1 walk-through works.
11. ADR 259 exists and is listed in docs/adr/index.md. README and agent docs correct.

## 8. Risks and known costs

- Install size: `@huggingface/transformers` pulls `onnxruntime-node` (~300 MB across all platforms; only the matching binary loads).
- First run: the first ONNX start downloads ~137 MB; needs network.
- glibc only: no musl/Alpine for the ONNX runtime (F4 changes the beacon-starting images).
- The model name is a canonical id, not a tag (removes the 2026-10-13 tag-drift failure; a tag lives only in `spec.backends`).

## 9. Deferred

- Shipping EmbeddingGemma 2 as a registry entry.
- Request-level role parameters for remote embedding APIs.
- A model-menu slash command or TUI surface.
- Making the wiki reindex route asynchronous.

## 10. Verified current-state facts (for the coder)

- `DroneEmbeddingProvider` at `drone-core/src/capabilities.ts:6`.
- Only implementation: `createOllamaEmbeddingProvider` in `drone-swarm-common/src/search-provider-ollama.ts`.
- Beacon instantiates it directly (not via a capability) at `drone-beacon/src/index.ts:281-305`, twice. Host = `process.env.OLLAMA_HOST || 'http://127.0.0.1:11434'`.
- Four hardcoded prefix call sites: `search-indexer.ts:122`, `wiki-indexer.ts:169` (`search_document:`); `routes/search.ts:154`, `routes/wiki.ts:287` (`search_query:`).
- Dimension hardcoded 768 in `db/init.ts:203` (`vec_chunks FLOAT[768]`), `:207` (`vec_chunks_bq BIT[768]`), `:243` (`wiki_vec_chunks FLOAT[768]`).
- `drone-beacon/Dockerfile` is already `node:22-slim`; `smoke-test`, `dummy-agent`, `echo-llm`, `drone-agent`, `drone-coordinator` are `node:22-alpine`.
- `replaceWikiChunks` exists and is exported from `db/index.ts` but `indexWiki` does not call it.
- `onnxruntime-node` ships a linux-arm64 (aarch64) prebuilt CPU binary since v1.10.0. `@huggingface/transformers` ~4.3.1 hard-depends on `onnxruntime-node@1.30.0` on Node; there is no automatic WASM fallback on Node. `env.cacheDir` is NOT read from `HF_HOME`/`TRANSFORMERS_CACHE`; set it explicitly.

---

## Outcome (2026-10-20) — COMPLETE

Branch `feat/ollama-free-embedding`. All phases A-G executed. Commits:
`a7568e2a` (plan + insights), `13a93be0` (phases A-E), `fea87a06` (phase F docs/docker).

### Shipped
- **A** `drone-core/src/embedding-models.ts` — `DroneEmbeddingModelSpec`,
  `NOMIC_EMBED_TEXT_V1_5`, `EMBEDDING_MODELS`, `getEmbeddingModel`,
  `listEmbeddingModels`, `listEmbeddingModelIds`. `DroneEmbeddingProvider` gains
  `spec`/`embedQuery`/`embedDocument`. `DroneSearchCapability` and the dead config
  fields deleted. Test: `drone-core/test/embedding-models.test.ts` (6).
- **B** `drone-swarm-common/src/embedding/` — `types.ts`, `fingerprint.ts`,
  `provider.ts`, `backend-onnx.ts`, `backend-ollama.ts`, `configure.ts`, `index.ts`.
  `search-provider-ollama.ts` deleted. `config-file.ts` gains `EmbeddingConfig`,
  `'embedding'` in `ALLOWED_KEYS`, `validateEmbedding`. Dep
  `@huggingface/transformers ^4.3.1`. Tests: fingerprint (2), provider (5),
  backend-ollama (7), config-file embedding block (26 total).
- **C** `drone-beacon/src/db/embedding-meta.ts` — `getEmbeddingMeta`,
  `setEmbeddingMeta`, `rebuildVecTables(dimensions)`. `embedding_meta` DDL.
  `initDatabase(dbPath, dimensions)` — dimension is a parameter, not hardcoded 768.
  `replaceWikiChunks` -> `replaceWikiPage(...)`; new `replaceFileChunks` in
  `db/search.ts`. Tests: embedding-meta (6), wiki-chunks (10).
- **D** Both indexers embed ALL chunks first, then write chunks + hash in one
  transaction; hashes are salted with the fingerprint; the wiki indexer skips only
  when the hash matches AND chunk count > 0; the four prefix literals become
  `embedQuery`/`embedDocument`. Tests: bug-A and bug-B proofs for both indexers.
- **E** `drone-beacon/src/embedding-init.ts` — `initEmbedding` / `resolveEmbeddingSpec`;
  fatal on unknown model or a backend that cannot start; reconciles `embedding_meta`
  and rebuilds the vec tables on a dimension change. `index.ts` wires it.
  Test: `embedding-wiring.test.ts` (6).
- **F** ADR `docs/adr/259-embedding-model-registry-and-de-ollama.md` + index row;
  new `docs/agents/embedding-providers.md` + AGENTS.md entry; README updated (Ollama
  no longer required); `docker/smoke-test.Dockerfile` -> `node:22-slim`
  (`drone-beacon.Dockerfile` was already slim). Wiki pages
  `drone-agent-node-only-embedding-providers`, `beacon-semantic-search`,
  `beacon-wiki-vector-index` updated to as-built.

### Validation (all green)
- `pnpm -r run build` OK; `pnpm run lint:eslint` OK; `pnpm run lint:prettier` OK;
  `tsc -p tsconfig.test.json` OK; `pnpm run test` = **4326 passed / 16 skipped**;
  LSP zero diagnostics.
- Live checks: an unknown `embedding.model` stops the beacon with
  `Unknown embedding model "<id>"` and exit 1; `embedding.backend: "wasm"` fails
  config validation with `"embedding.backend" must be "onnx" or "ollama"`; the
  in-process ONNX backend fails hard (as designed, D5) when the model cannot be
  downloaded.

### Deviations / limits
- **G1 items 1-2 could not run on this host.** Hugging Face returns 401 to a plain
  `curl` for the model files, so the ~137 MB ONNX download cannot happen here. The
  hard-fail path (D5) is what was observed; the download + semantic-search walk-through
  needs a host with HF Hub access.
- **F5 partial:** the two 2026-10-13 bug wiki pages could not be located —
  `swarm__wiki_search` returns empty for every query on this beacon (a known
  recurring defect; `wiki_list`/`wiki_read` work). The three named embedding pages
  were updated; the bug pages remain to be marked fixed by a librarian.
- The `embedDocument(text, { title })` second argument is unused by Nomic
  (`supportsTitle: false`) but is part of the shape a title-using model needs.
- The fingerprint change is **not** announced on first startup; a model/backend/dtype
  change silently discards the index on the next pass.

### Deferred (unchanged)
EmbeddingGemma 2 as a shipped registry entry; request-level role parameters;
a model-menu surface; an async wiki reindex route.
