---
key: plan-semantic-search
tags:
  []
created: 2026-07-14T20:06:09.160Z
updated: 2026-07-14T21:33:58.816Z
---

# Plan: Semantic Search (Item 15)

## Summary

Implement real semantic search in the `search` plugin. Currently `mode: "semantic"` is a stub that returns "not yet implemented". This plan fills it in with:

- Config-driven indexed directories (user-level vs project-level)
- SQLite-backed vector storage (separate DBs per scope)
- Content-hash-based incremental indexing (no full reindex on startup)
- Pluggable embedding model providers via a registration hook
- First embedding provider: Ollama + Nomic (opinionated/lazy)
- Graceful degradation: semantic mode hidden when no providers registered

## Architecture

### Config (`drone-core/src/config-types.ts`)

Add `DroneSearchConfig` to `DroneAgentConfig`:

```typescript
type DroneSearchIndexedDir = {
  path: string; // Absolute or relative path
  embeddingProvider?: string; // Optional provider override for this dir
};

type DroneSearchConfig = {
  enabled: boolean;
  indexedDirectories: DroneSearchIndexedDir[];
  // Per-scope embedding provider selection
  userEmbeddingProvider?: string; // Provider for user-level index
  projectEmbeddingProvider?: string; // Provider for project-level index
};
```

User config adds user-level dirs, project config adds project-level dirs. The search plugin merges them.

**Critical design point**: The project-level index and user-level index can use **different** embedding providers. The `projectEmbeddingProvider` config key (set in project config) controls which provider generates embeddings for the project index. The `userEmbeddingProvider` config key (set in user config) controls the user index. This means:

- A project can pin a specific embedding provider so all contributors use the same vectors (enabling checked-in index files if desired)
- A user can independently choose a different provider for their personal index
- When searching, the plugin uses the provider that was used to build the index being searched (stored per-DB, not per-query)

### SQLite Storage

Two separate SQLite databases (using `better-sqlite3`):

- `~/.drone-agent/search-index.db` (user scope)
- `<project>/.drone-agent/search-index.db` (project scope)

Tables:

```sql
CREATE TABLE files (
  path TEXT PRIMARY KEY,       -- Absolute path to the file
  hash TEXT NOT NULL,           -- SHA-256 hex digest of file content
  last_indexed TEXT NOT NULL    -- ISO-8601 timestamp
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,  -- Position within the file
  text TEXT NOT NULL,             -- The chunk text
  embedding BLOB NOT NULL         -- Float32 vector as binary blob
);

CREATE INDEX idx_chunks_file ON chunks(file_path);
```

### Embedding Provider Hook

Define in `drone-core/src/capabilities.ts`:

```typescript
type DroneEmbeddingProvider = {
  id: string;
  name: string;
  /** Get the embedding vector for a text string. */
  getEmbedding(text: string): Promise<Float32Array>;
  /** Number of dimensions in the embedding vectors. */
  dimensions: number;
  /** Maximum number of tokens per chunk (for chunking). */
  maxTokens: number;
};

type DroneSearchCapability = {
  registerEmbeddingProvider(provider: DroneEmbeddingProvider): void;
  unregisterEmbeddingProvider(id: string): void;
  getEmbeddingProviders(): DroneEmbeddingProvider[];
  /** Get the provider to use for a given scope/dir. */
  resolveProvider(
    scope: 'user' | 'project',
    dirPath?: string
  ): DroneEmbeddingProvider | undefined;
};
```

### Incremental Indexing (Content Hash)

On startup and on demand:

1. Walk configured directories, collect all file paths
2. For each file, compute SHA-256 hash
3. Query SQLite: if `hash` matches, skip (no change)
4. If hash differs or file is new: reindex (chunk + embed)
5. If file no longer exists: remove from DB (cascade deletes chunks)

Chunking strategy: split by paragraph boundaries, max `maxTokens` tokens per chunk (from the provider), with overlap.

### Search Plugin Changes

The `search` plugin (`drone-agent/src/plugins/search.ts`):

1. **Offer `DroneSearchCapability`** via `registration.offer()`
2. **Register `onPluginsLoaded` hook** to initialize SQLite DBs and run initial indexing
3. **Update `search__text` tool**: when `mode: "semantic"` is selected and at least one provider is registered, perform cosine similarity search against the SQLite index
4. **Graceful degradation**: if no embedding providers are registered, `mode: "semantic"` is removed from the enum (or the tool description says "no embedding providers available")
5. **Register `onShutdown` hook** to close SQLite connections cleanly

### Ollama + Nomic Embedding Provider

A new file `drone-agent/src/plugins/search/providers/ollama.ts`:

- Uses Ollama's embedding API (`POST /api/embed` with model `nomic-embed-text:v1.5`)
- **Important**: Nomic requires task instruction prefixes per the [model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5):
  - For indexing chunks: prefix with `search_document: <text>`
  - For querying: prefix with `search_query: <text>`
- 768 dimensions, 8192 max tokens
- Registers itself with the search plugin's capability
- Simple: no config beyond the Ollama host (reuses `ollama.host` from config)

### Steps

1. Add `DroneSearchConfig` to `drone-core/src/config-types.ts` (type, defaults, merge)
2. Add `DroneEmbeddingProvider` and `DroneSearchCapability` to `drone-core/src/capabilities.ts`
3. Export new types from `drone-core/src/index.ts`
4. Add `better-sqlite3` dependency to `drone-agent/package.json`
5. Add `search` to `KNOWN_CONFIG_KEYS` in config plugin
6. Implement SQLite storage layer (`drone-agent/src/plugins/search/store.ts`)
7. Implement incremental indexing logic (`drone-agent/src/plugins/search/indexer.ts`)
8. Implement cosine similarity search (`drone-agent/src/plugins/search/searcher.ts`)
9. Rewrite `search.ts` → `plugins/search/index.ts` with capability offering, tool update, hooks
10. Implement Ollama + Nomic embedding provider (`plugins/search/providers/ollama.ts`)
11. Add tests
12. Verify build, lint, tests pass
13. Commit
14. Update project memory

### Validation Criteria

- [x] `search` config section exists with `indexedDirectories`, `userEmbeddingProvider`, `projectEmbeddingProvider`
- [x] SQLite DBs created at user and project scope with correct schema
- [x] Incremental indexing: only reindexes files whose content hash changed
- [x] `mode: "semantic"` works with at least one embedding provider registered
- [x] `mode: "semantic"` gracefully degrades (removed from enum) when no providers registered
- [x] Multiple embedding providers can be registered and selected by scope
- [x] Project-level index uses `projectEmbeddingProvider`; user-level index uses `userEmbeddingProvider` — they can differ
- [x] Ollama + Nomic provider works out of the box, using `search_document:` prefix for indexing and `search_query:` prefix for queries
- [x] All existing tests pass
- [x] LSP diagnostics pass
- [x] `pnpm -r run build` passes
- [x] `pnpm -r run lint` passes

## Implementation Summary (2026-07-14)

All 14 steps completed. The old `drone-agent/src/plugins/search.ts` was replaced with a new `drone-agent/src/plugins/search/` directory containing:

- `index.ts` — Plugin registration, capability offering, tool handler, lifecycle hooks
- `store.ts` — SQLite-backed SearchStore (meta, files, chunks tables)
- `indexer.ts` — Incremental indexing with content-hash detection, paragraph chunking
- `searcher.ts` — Cosine similarity search with minScore filtering
- `providers/ollama.ts` — Ollama + Nomic embedding provider

16 new tests added covering SearchStore CRUD, semantic search with mock embeddings, and the plugin's regex search behavior. All 1474 existing tests pass. Build and lint pass cleanly.
