---
key: plan-semantic-search
tags: []
created: 2026-07-14T20:06:09.160Z
updated: 2026-07-29T03:15:55.960Z
---

# Plan: Move Semantic Search to Beacon

## Summary

Move the vector indexing and semantic search functionality from the agent's local search plugin into the beacon process. The agent's search plugin keeps regex search (local, always available) and gains an optional dependency on the swarm plugin — when swarm is connected, semantic search tools proxy to the beacon. The beacon handles background indexing, deduplicating indexes across agents that register the same directories. Shared vector store, chunking, and search logic go into `drone-swarm-common` for reuse by the coordinator (future wiki semantic search).

## Key Design Decisions

1. **Search paths communicated via separate beacon endpoint** (`POST /agents/:id/search-paths`), not in agent registration payload — keeps optional plugin from breaking agent registration
2. **Single SQLite DB with `directory_path` column** for deduplication — one index per directory, shared across agents
3. **Regex search stays local** in the agent — only semantic mode moves to the beacon
4. **Shared code in `drone-swarm-common`** — `SearchStore`, chunking, cosine similarity, embedding provider — so coordinator can reuse for wiki search
5. **Semantic search goes dead without swarm** — no local fallback; users who want semantic search without swarm should use an MCP server

## Steps

### Step 1: Move shared vector search code to `drone-swarm-common`

**Why**: Both the beacon (for agent file indexing) and coordinator (for future wiki semantic search) need the same vector store, chunking, and search logic.

**Files to create/modify:**

1. **`drone-swarm-common/package.json`** — Add `better-sqlite3` and `@types/better-sqlite3` dependencies

2. **`drone-swarm-common/src/search-store.ts`** — Move and refactor `SearchStore` from `drone-agent/src/plugins/search/store.ts`
   - Keep the same schema (`meta`, `files`, `chunks` tables)
   - Add a `directory_path` column to `files` and `chunks` tables for deduplication
   - Add methods: `getFilesByDirectory(dirPath)`, `removeFilesByDirectory(dirPath)`, `getDirectoryPaths()`
   - Use `better-sqlite3` directly (synchronous API) — the async wrappers in the current store are unnecessary overhead

3. **`drone-swarm-common/src/search-chunker.ts`** — Move `chunkText` from `drone-agent/src/plugins/search/indexer.ts`
   - Pure function, no dependencies on agent code
   - Export `chunkText(text: string, maxTokens: number): string[]`

4. **`drone-swarm-common/src/search-searcher.ts`** — Move `cosineSimilarity` and `semanticSearch` from `drone-agent/src/plugins/search/searcher.ts`
   - `semanticSearch` takes a `SearchStore`, `DroneEmbeddingProvider`, query, and options
   - Pure computation, no agent dependencies

5. **`drone-swarm-common/src/search-provider-ollama.ts`** — Move `createOllamaEmbeddingProvider` from `drone-agent/src/plugins/search/providers/ollama.ts`
   - Same interface, no agent dependencies

6. **`drone-swarm-common/src/index.ts`** — Add exports for all new modules

7. **`drone-core/src/capabilities.ts`** — Add `DroneSearchIndexer` capability type (for beacon to expose indexing control to agents)

### Step 2: Add beacon search database tables

**File**: `drone-beacon/src/db/init.ts` — Add `search_directories`, `search_files`, `search_chunks` tables with `directory_path` column for dedup

**File**: `drone-beacon/src/db/search.ts` — New DB module with CRUD for search paths, files, and chunks

**File**: `drone-beacon/src/db/index.ts` — Add exports for new search DB functions

### Step 3: Add beacon search routes

**File**: `drone-beacon/src/routes/search.ts` — Three endpoints:

- `PUT /agents/:id/search-paths` — Set search paths for an agent
- `GET /agents/:id/search` — Semantic search (query, maxResults, minScore, path)
- `POST /agents/:id/search/reindex` — Trigger reindexing

**File**: `drone-beacon/src/routes/index.ts` — Add `search(app)` to route registration

### Step 4: Add beacon background indexing service

**File**: `drone-beacon/src/search-indexer.ts` — `SearchIndexer` class that:

- Indexes directories in the background (non-blocking)
- Deduplicates across agents (same directory = one index)
- Uses shared `SearchStore`, `chunkText`, `createOllamaEmbeddingProvider` from `drone-swarm-common`
- Runs periodic hash sweep (configurable interval, default 5 min)

### Step 5: Refactor agent search plugin

**File**: `drone-agent/src/plugins/search/index.ts` — Remove local vector code, add optional swarm dependency, proxy semantic search to beacon

**File**: `drone-agent/src/plugins/index.ts` — Update search plugin metadata with optional swarm dependency

### Step 6: Update config types

**File**: `drone-core/src/config-types.ts` — No type changes needed; semantics shift but shape stays the same

### Step 7: Wire up agent → beacon search path registration

**File**: `drone-agent/src/plugins/search/index.ts` — In `onPluginsLoaded`, read `search.paths` from config, call `PUT /agents/:id/search-paths` if swarm is available

### Step 8: Clean up removed files

Delete `store.ts`, `indexer.ts`, `searcher.ts`, `providers/ollama.ts` from `drone-agent/src/plugins/search/`

### Step 9: Validation

1. `pnpm -r run build` passes
2. `pnpm -r run typecheck` passes
3. `pnpm -r run lint` passes
4. `pnpm -r run test` passes
5. LSP diagnostics show zero errors
6. Manual smoke test

## Reindexing Strategy

**Two-pronged approach:**

1. **Agent-side `onAfterToolCall` hook** — Search plugin hooks into `onAfterToolCall`, checks for file-modifying tools (e.g., `file__write`, `file__apply_diff`), sends targeted reindex request to beacon for affected files.

2. **Beacon-side periodic hash sweep** — `SearchIndexer` runs a background sweep every N minutes (configurable, default 5). Walks files, computes hashes, reindexes files whose hash doesn't match stored hash. Lightweight because it only hashes changed files.

## Future Work (not in this plan)

- Coordinator wiki semantic search using shared `SearchStore`
- Coordinator knowledge semantic search
- Per-path embedding provider override wiring
