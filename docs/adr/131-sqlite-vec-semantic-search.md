---
tags: [decision, search, semantic-search, sqlite-vec, beacon, vector-search]
related: [concepts/semantic-search.md, modules/drone-beacon.md, modules/drone-swarm-common.md, decisions/127-semantic-search-beacon.md, decisions/129-structure-aware-chunking.md, decisions/130-dedupe-search-results-by-file.md]
---

# 131. Move Semantic Search to sqlite-vec (SIMD Brute-Force)

**Summary**: Replace the beacon's brute-force JS cosine loop with **sqlite-vec**, a pure-C SQLite extension that does SIMD-accelerated brute-force KNN inside the existing SQLite DB. Keeps everything in the `search_chunks` table (no new service, no separate index to sync) while moving per-row scoring from interpreted JS into C.

## Context

`semanticSearch` and the beacon route previously did `getAllChunks()` (load every row into memory) then computed cosine similarity in a JS loop — O(N) memory and CPU per query. At tens of thousands of rows this won't scale. sqlite-vec's `vec0` virtual table does SIMD-accelerated brute-force KNN (AVX/NEON) in C, staying in the existing SQLite DB.

## Key findings (validated by smoke tests)

1. **`vec0` is brute-force only** — no HNSW, and **768-dim works fine** (the "512-dim HNSW limit" doesn't apply to sqlite-vec's `vec0`). No dimension reduction needed.
2. **Production path is the beacon's `search_chunks` table + route** — `SearchStore`/`semanticSearch` in `drone-swarm-common` were test-only dead code (a prototype never wired into production). The migration targeted the beacon.
3. **Critical gotcha: better-sqlite3 binds JS numbers as `REAL`, but vec0 requires genuine `INTEGER` for rowid.** Must bind rowid as **`BigInt`** (or `CAST(? AS INTEGER)`).
4. **Rowid mirroring works**: capture `lastInsertRowid` from the source insert, mirror into vec0 with `BigInt(rowid)`, join back on `c.rowid = v.rowid`.
5. **Delete by rowid works** (`DELETE FROM vec_chunks WHERE rowid = ?` with `BigInt`).
6. **Exclude filtering needs over-fetch**: fetch a larger candidate set, apply exclude globs, dedupe, slice to `maxResults`.

## Decision

1. **sqlite-vec lives in `drone-beacon`** (native extension, only one consumer) — not the shared `drone-swarm-common`.
2. **`vec0` table mirrors `search_chunks` rowids** — no metadata column needed; join back on `rowid`.
3. **Trigger-free sync** — explicit vec0 writes in `db/search.ts` (`insertChunk`, `deleteChunksForFile`, `removeFilesByDirectory`).
4. **Over-fetch for exclude** — fetch `maxResults × OVERFETCH_FACTOR` (4) candidates, apply exclude globs, dedupe, slice.
5. **`distance_metric=cosine`** on the vec0 column — returns cosine distance (0 = identical), convert to similarity (`1 - distance`) for the response.
6. **Backfill migration** — automatic on startup: if `vec_chunks` is empty and `search_chunks` has rows, copy embeddings into vec0 in a transaction.
7. **Dead-code removal** — remove `SearchStore`, `semanticSearch`, and `cosineSimilarity` (all test-only / superseded by vec0). **Keep `dedupeAndCombineChunks`** (genuinely used by the beacon route).

## Implementation

- Added `sqlite-vec@0.1.9` to `drone-beacon`.
- `db/init.ts` — `sqliteVec.load(db)` after `new Database(...)`, plus a `vec_chunks` vec0 virtual table (`FLOAT[768] distance_metric=cosine`).
- `db/search.ts` — `insertChunk` mirrors into vec0 (binding rowid as `BigInt`); `deleteChunksForFile`/`removeFilesByDirectory` clean up vec0 rows; `searchChunksByVector` runs the KNN query and joins back to `search_chunks`; `backfillVecChunks` copies existing chunks into vec0 in a transaction.
- Beacon startup (`index.ts`) — wires automatic backfill.
- `routes/search.ts` — uses `searchChunksByVector` with an over-fetch factor of 4, then applies exclude globs and `dedupeAndCombineChunks`.
- Removed dead code: `search-store.ts`, `semanticSearch`, `cosineSimilarity`, and their tests.

## Result

The beacon's semantic search is now SIMD-accelerated in C inside SQLite, scaling to tens of thousands of rows without loading the whole table into memory per query.

## Related

- [[decisions/127-semantic-search-beacon]] — semantic search moved to the beacon
- [[decisions/129-structure-aware-chunking]] — structure-aware chunking
- [[decisions/130-dedupe-search-results-by-file]] — file-level dedup
- [[concepts/semantic-search]] — the semantic search concept
- [[modules/drone-beacon]] — beacon module
- [[modules/drone-swarm-common]] — shared dedup helper (kept)
