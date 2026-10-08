---
tags: [decision, search, semantic-search, dedup, beacon, drone-swarm-common]
related:
  [
    concepts/semantic-search.md,
    modules/drone-beacon.md,
    modules/drone-swarm-common.md,
    decisions/129-structure-aware-chunking.md,
    decisions/131-sqlite-vec-semantic-search.md,
  ]
---

# 130. Deduplicate Semantic Search Results by File

**Summary**: Deduplicate semantic search results so each file appears at most once. For each file, keep the highest-scoring chunk's `score`/`chunkIndex` for ranking, but combine the text of all matching chunks into the result's `content`, inserting a `[...]` gap marker between non-consecutive chunks.

## Context

After structure-aware chunking ([129-structure-aware-chunking](129-structure-aware-chunking.md)), a single file now produces many chunks, so a query matching several chunks from the same file returned that file multiple times (once per matching chunk). The fix is file-level dedup keeping the best chunk's score, combining the matching chunks' text, with a gap marker when chunks are non-consecutive.

## Decision

1. **Shared pure function** `dedupeAndCombineChunks(scored, { maxResults, maxCombinedChars = 8000 })` in `drone-swarm-common/src/search-searcher.ts` — dedups by file, keeps best score, combines texts with gap markers, caps combined size, slices to `maxResults` files.
2. **`semanticSearch`** calls it after scoring (reusable by the coordinator's future wiki search).
3. **Beacon route** calls it after its own scoring + exclude filtering. This is the "spirit of B": the dedup logic is shared, but the beacon doesn't literally call `semanticSearch` (which would require a risky storage-layer refactor since the beacon uses `db.*` and has exclude filtering).
4. **Gap marker**: `[...]` on its own line between non-consecutive chunks (consecutive chunks join with a blank line, no marker).
5. **Combined-size cap**: `maxCombinedChars = 8000` (safety bound so a file with many matching chunks doesn't bloat the response).
6. **Ranking**: entry's `score`/`chunkIndex` come from the best chunk; combined text is the payload.
7. **`resultCount`/`truncated`** now reflect unique files, not chunks.

## Implementation

- Added `ScoredChunk` type and `dedupeAndCombineChunks` to `drone-swarm-common/src/search-searcher.ts`.
- `semanticSearch` builds `ScoredChunk[]` during scoring and returns `dedupeAndCombineChunks(scored, { maxResults })`.
- The beacon `/agents/:id/search` route maps its exclude-filtered scored rows to `ScoredChunk`, calls `dedupeAndCombineChunks`, and maps back.

## Result

Each file appears at most once in results, with the best chunk's score and the combined matching-chunk text. This preserved the "small-to-big" retrieval philosophy — retrieve small units, present fuller context.

## Related

- [129-structure-aware-chunking](129-structure-aware-chunking.md) — structure-aware chunking that created the multi-chunk-per-file problem
- [131-sqlite-vec-semantic-search](131-sqlite-vec-semantic-search.md) — vector search moved to sqlite-vec
- semantic-search — the semantic search concept
- [drone-beacon](../../drone-beacon/) — beacon module
- [drone-swarm-common](../../drone-swarm-common/) — shared dedup helper
