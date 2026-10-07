---
tags: [decision, search, semantic-search, swarm]
related: [modules/drone-beacon.md, modules/drone-swarm-common.md, modules/drone-agent-plugins.md, concepts/semantic-search.md, decisions/128-search-exclude-query-time-filtering.md]
---

# 127. Semantic Search Moved to the Beacon

**Summary**: Moved vector indexing and semantic search from the agent's local search plugin into the beacon process. The agent's search plugin keeps local regex search and gains an optional swarm dependency — when connected to a beacon, semantic search tools proxy to the beacon via HTTP. Shared vector store, chunking, and search logic moved into `drone-swarm-common` for reuse by the coordinator (future wiki semantic search).

## Context

The agent previously ran its own local SQLite vector index and embedding provider for `search__text` with `mode: "semantic"`. This had several drawbacks:

1. **Index duplication** — each agent built its own index of the same directories, wasting disk and compute.
2. **No deduplication** — multiple agents indexing the same directory produced duplicate, inconsistent indexes.
3. **Embedding cost** — each agent ran its own embedding provider, doubling Ollama load.
4. **Not reusable** — the vector logic was locked inside the agent and couldn't be shared with the coordinator (which needs semantic search over the project wiki).

## Decision

### 1. Search paths via a separate beacon endpoint

Search paths are communicated via a dedicated `PUT /agents/:id/search-paths` endpoint, **not** in the agent registration payload. This keeps the optional search plugin from breaking agent registration when disabled.

### 2. Single SQLite DB with `directory_path` column for dedup

The beacon maintains a single shared index. Each row carries a `directory_path` column, so one index per directory is shared across all agents that register the same directory. This eliminates duplicate indexing.

### 3. Regex search stays local

Only semantic search moves to the beacon. Regex (`search__text` with `mode: "regex"`, ripgrep/grep) remains local and always available.

### 4. Shared code in `drone-swarm-common`

The vector store (`SearchStore`), chunking (`chunkText`), cosine similarity / `semanticSearch`, and the Ollama embedding provider (`createOllamaEmbeddingProvider`) moved into `drone-swarm-common` so the coordinator can reuse them for wiki semantic search in the future.

### 5. Semantic search is dead without swarm

There is no local fallback for semantic search. If the swarm plugin isn't connected to a beacon, `search__text` with `mode: "semantic"` returns a note explaining that a beacon connection is required (and suggesting an MCP server for vector search). Users who want semantic search without a swarm should use an MCP server.

## Beacon Architecture

- **`routes/search.ts`** — Three endpoints:
  - `PUT /agents/:id/search-paths` — Register/unregister search paths for an agent; triggers background indexing
  - `GET /agents/:id/search` — Semantic search (query, `maxResults`, `minScore`, `path`, `exclude`)
  - `POST /agents/:id/search/reindex` — Trigger reindexing of an agent's paths
- **`search-indexer.ts`** — `SearchIndexer` class: background indexing, dedup across agents, periodic hash sweep (default 5 min). Exposes the `DroneEmbeddingProvider` via `getProvider()`.
- **`db/search.ts`** — CRUD for `search_directories`, `search_files`, `search_chunks` tables.
- **`db/init.ts`** — Added the three search tables with `directory_path` for dedup.

The `SearchIndexer` is instantiated in `drone-beacon/src/index.ts:186-191`, wired via `setSearchIndexer` (context.ts), and started with `startPeriodicSweep()`.

## Agent Architecture

- **`drone-agent/src/plugins/search/index.ts`** — Regex search stays local. Semantic search proxies to the beacon:
  - In `onPluginsLoaded`, reads `search.paths` from config and calls `PUT /agents/:id/search-paths` when swarm is available.
  - Registers a prompt fragment (`search-indexed-directories`) listing indexed directories so the model knows which dirs are semantic-searchable.
  - `handleSemanticSearch` resolves the swarm capability, builds query params (`q`, `maxResults`, `minScore`, `path`, `exclude`), and fetches the beacon's `GET /agents/:id/search`.
- Deleted local files: `store.ts`, `indexer.ts`, `searcher.ts`, `providers/ollama.ts`.

## Config

`DroneSearchPath` (in `drone-core/src/config-types.ts`) gained `includeHidden`, `includeNodeModules`, and `exclude` flags (see [[decisions/128-search-exclude-query-time-filtering]]). The `search` section was added to the TypeBox schema (`config-schema.ts`).

## Reindexing Strategy

Two-pronged:

1. **Agent-side `onAfterToolCall` hook** — the search plugin hooks into `onAfterToolCall`, detects file-modifying tools, and sends targeted reindex requests to the beacon.
2. **Beacon-side periodic hash sweep** — `SearchIndexer.runSweep()` walks indexed directories every N minutes (default 5), computes hashes, and reindexes changed files.

## Result

- `drone-beacon` now owns the shared vector index with per-directory dedup.
- `drone-swarm-common` exposes the reusable vector primitives.
- Semantic search is available whenever the swarm plugin is connected to a beacon.

## Related

- [[decisions/128-search-exclude-query-time-filtering]] — query-time `exclude` glob filtering
- [[concepts/semantic-search]] — the semantic search concept
- [[modules/drone-beacon]] — beacon module
- [[modules/drone-swarm-common]] — shared vector primitives
