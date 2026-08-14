---
key: plan-sqlite-vec-semantic-search
tags:
  []
created: 2026-08-14T06:41:52.571Z
updated: 2026-08-14T06:58:13.133Z
---

---
key: plan-sqlite-vec-semantic-search
tags: [search, semantic-search, sqlite-vec, beacon, vector-search]
created: 2026-08-14T00:00:00.000Z
updated: 2026-08-14T00:00:00.000Z
---

# Plan: Move Semantic Search to sqlite-vec (SIMD Brute-Force)

## Summary

Replace the beacon's brute-force JS cosine loop with **sqlite-vec** — a pure-C SQLite extension that does SIMD-accelerated brute-force KNN inside the existing SQLite DB. This keeps everything in the current `search_chunks` table (no new service, no separate index to sync) while moving the per-row scoring from interpreted JS into C. For 10k–100k rows of 768-dim vectors, this is orders of magnitude faster.

## Context

`semanticSearch` and the beacon route currently do `getAllChunks()` (load every row) then compute cosine similarity in a JS loop — O(N) memory and CPU per query. At tens of thousands of rows this won't scale. sqlite-vec's `vec0` virtual table does SIMD-accelerated brute-force KNN (AVX/NEON) in C, staying in the existing SQLite DB.

## Key findings (validated by smoke tests)

1. **`vec0` is brute-force only** — no HNSW, and **768-dim works fine** (the "512 limit" doesn't apply). No dimension reduction needed.
2. **Production path is the beacon's `search_chunks` table + route** — `SearchStore`/`semanticSearch` in `drone-swarm-common` are test-only dead code. Migration targets the beacon.
3. **Critical gotcha: better-sqlite3 binds JS numbers as `REAL`, but vec0 requires genuine `INTEGER` for rowid.** Must bind rowid as **`BigInt`** (or `CAST(? AS INTEGER)`). Verified working.
4. **Rowid mirroring works**: capture `lastInsertRowid` from the source insert, mirror into vec0 with `BigInt(rowid)`, join back on `c.rowid = v.rowid`.
5. **Delete by rowid works** (`DELETE FROM vec_chunks WHERE rowid = ?` with `BigInt`).
6. **Exclude filtering needs over-fetch**: fetch a larger candidate set, apply exclude globs, dedupe, slice to `maxResults`.

## Design decisions

1. **sqlite-vec lives in `drone-beacon`** (native extension, only one consumer) — not the shared `drone-swarm-common`.
2. **`vec0` table mirrors `search_chunks` rowids** — no metadata column needed; join back on `rowid`.
3. **Trigger-free sync** — explicit vec0 writes in `db/search.ts` (`insertChunk`, `deleteChunksForFile`, `removeFilesByDirectory`).
4. **Over-fetch for exclude** — fetch `maxResults × OVERFETCH_FACTOR` (4) candidates, apply exclude globs, dedupe, slice.
5. **`distance_metric=cosine`** on the vec0 column — returns cosine distance (0 = identical), convert to similarity (`1 - distance`) for the response.
6. **Backfill migration** — automatic on startup: if `vec_chunks` is empty and `search_chunks` has rows, copy embeddings into vec0 in a transaction.
7. **Dead-code removal** — remove `SearchStore`, `semanticSearch`, and `cosineSimilarity` (all test-only / superseded by vec0). **Keep `dedupeAndCombineChunks`** (genuinely used by the beacon route).

## Steps

### Step 1 — Add sqlite-vec dependency to the beacon *(coder)*
**File:** `drone-beacon/package.json`

Add `sqlite-vec` (pin exact version, e.g. `0.1.9`). It's a native-extension package with prebuilt binaries.

### Step 2 — Load the extension in DB init *(coder)*
**File:** `drone-beacon/src/db/init.ts`

In `initDatabase()`, after `new Database(dataPath)`, call `sqliteVec.load(db)`. Add the `vec_chunks` vec0 table to the schema:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding FLOAT[768] distance_metric=cosine
);
```
Note: verify sqlite-vec supports `CREATE VIRTUAL TABLE IF NOT EXISTS` (it should).

### Step 3 — Add vec0 write helpers to `db/search.ts` *(coder)*
**File:** `drone-beacon/src/db/search.ts`

- `insertChunk`: after inserting into `search_chunks`, capture `lastInsertRowid` and mirror into `vec_chunks` with `BigInt(rowid)`.
- `deleteChunksForFile`: after deleting from `search_chunks`, delete matching rows from `vec_chunks` by rowid (select rowids first, or use a subquery).
- `removeFilesByDirectory`: same — delete vec0 rows for the directory's chunks.
- Add a `searchChunksByVector(queryEmbedding, k)` helper that runs the vec0 KNN query and joins back to `search_chunks`.

### Step 4 — Update the search route to use vec0 *(coder)*
**File:** `drone-beacon/src/routes/search.ts`

Replace the `getAllChunks` + JS cosine loop with:
1. `provider.getEmbedding('search_query: ' + q)`.
2. `db.searchChunksByVector(queryEmbedding, maxResults × OVERFETCH_FACTOR)` → returns `{ filePath, chunkIndex, text, score }` (score = `1 - distance`).
3. Apply `isExcluded` globs.
4. `dedupeAndCombineChunks(scored, { maxResults })`.
5. Return the same response shape.

### Step 5 — Backfill migration *(coder)*
**File:** `drone-beacon/src/db/search.ts` (or a migration helper)

A one-time function that copies existing `search_chunks` embeddings into `vec_chunks` (using their implicit rowids), run in a transaction. Called on startup if `vec_chunks` is empty and `search_chunks` has rows.

### Step 6 — Tests *(tester)*
- `drone-beacon/test/db/search.test.ts` (new or extended): `insertChunk` mirrors into vec0; `deleteChunksForFile`/`removeFilesByDirectory` clean up vec0; `searchChunksByVector` returns correct results ordered by distance.
- `drone-beacon/test/routes.test.ts`: update the search route tests to verify vec0-backed results (same response shape, dedup, exclude).
- Verify the existing `semanticSearch`/`SearchStore` tests still pass (unchanged, test-only).

### Step 7 — Remove dead code (`SearchStore`/`semanticSearch`/`cosineSimilarity`) *(coder)*
- Delete `drone-swarm-common/src/search-store.ts`.
- In `drone-swarm-common/src/search-searcher.ts`, remove `SearchStore` import, `SearchOptions`, `semanticSearch`, `cosineSimilarity`, and the `SearchChunkRow` usage. **Keep `ScoredChunk`, `dedupeAndCombineChunks`, `DedupeOptions`, `SearchResult`.**
- Update `drone-swarm-common/src/index.ts` exports (remove `search-store.js`).
- Delete `drone-swarm-common/test/search-searcher.test.ts` (only tests `dedupeAndCombineChunks` — move those cases into a new `dedupe` test file or keep a trimmed version).
- Update `drone-agent/test/search.test.ts`: remove the `SearchStore`/`semanticSearch` describe blocks and the `SearchStore`/`semanticSearch` imports.

### Step 8 — Review *(reviewer)*
Check correctness, dead code, and that all consumers of the beacon search route are covered (agent-side passes through the beacon response). Verify no remaining references to removed symbols.

### Step 9 — Validation *(coder)*
Run the full validation criteria below.

## Validation criteria

1. **LSP diagnostics clean** for all touched files (no new errors; pre-existing branch diagnostics out of scope).
2. `pnpm -r run build` passes (run **before** relying on LSP in `drone-beacon`).
3. `pnpm -r run typecheck` passes.
4. `pnpm -r run lint` passes.
5. `pnpm -r run test` passes (fast suite).
6. New vec0 logic covered by unit tests (Step 6).
7. No dead code / unused imports (including removed `SearchStore`/`semanticSearch`/`cosineSimilarity`).

## Future work (not in this plan)
- If the index grows to millions of rows, consider partition keys or a dedicated ANN library.
- Coordinator wiki semantic search (reuses `dedupeAndCombineChunks`).

---

## Execution Summary (completed 2026-08-14 by code persona)

All 9 steps implemented and validated. Commit: `7755b4f`.

- **Step 1**: Added `sqlite-vec@0.1.9` (pinned) to `drone-beacon/package.json`.
- **Step 2**: In `db/init.ts`, added `sqliteVec.load(db)` after `new Database(dataPath)` and a `vec_chunks` vec0 virtual table (`FLOAT[768] distance_metric=cosine`). Verified `CREATE VIRTUAL TABLE IF NOT EXISTS` works.
- **Step 3**: In `db/search.ts`, `insertChunk` now captures `lastInsertRowid` and mirrors into vec0 with `BigInt(rowid)`; `deleteChunksForFile`/`removeFilesByDirectory` select rowids first then delete from vec0; added `searchChunksByVector(queryEmbedding, k, directoryPath?)` (KNN query + join back, returns `{ directoryPath, filePath, chunkIndex, text, score }` with `score = 1 - distance`); added `backfillVecChunks()` (transactional copy if vec0 empty). Exported the new functions from `db/index.ts`.
- **Step 4**: `routes/search.ts` now uses `searchChunksByVector` with `OVERFETCH_FACTOR = 4`, filters by `minScore` and `isExcluded`, then `dedupeAndCombineChunks`. Removed the `cosineSimilarity` import.
- **Step 5**: Wired `backfillVecChunks()` into beacon startup in `index.ts` (logs if backfilled).
- **Step 6**: Added `drone-beacon/test/db-search.test.ts` (7 cases: insert mirror, order by distance, directory scope, delete cleanup, removeFilesByDirectory cleanup, backfill, backfill no-op). Updated `routes.test.ts` and `search-indexer.test.ts` mock providers/embeddings to 768-dim (vec0 requires it).
- **Step 7**: Removed dead code — deleted `search-store.ts`, trimmed `search-searcher.ts` to keep only `dedupeAndCombineChunks`/`ScoredChunk`/`DedupeOptions`/`SearchResult`, removed `search-store.js` export from `index.ts`, removed the `SearchStore`/`semanticSearch` describe blocks and imports from `drone-agent/test/search.test.ts`. Kept `drone-swarm-common/test/search-searcher.test.ts` (only tests the kept `dedupeAndCombineChunks`).
- **Step 8**: Review — no remaining references to removed symbols; `getAllChunks` still used by a test (kept); removed a pre-existing unused `logger` import in `db/search.ts`.
- **Step 9**: Validation all green — LSP clean on touched files (pre-existing `currentDirs` hint in routes/search.ts unchanged); `pnpm -r run build` ✓; `pnpm -r run typecheck` ✓; `pnpm lint` ✓; `pnpm test` ✓ (1907 passed, 9 skipped).

**Notable implementation details / deviations:**
- **vec0 KNN queries require a `k = ?` constraint, not `LIMIT ?`** — using `LIMIT` throws "A LIMIT or 'k = ?' constraint is required on vec0 knn queries." Fixed by using `AND k = ?`.
- **vec0 requires 768-dim embeddings** — the existing route/search-indexer tests used 4-dim mock embeddings, which broke with "Dimension mismatch for inserted vector... Expected 768 dimensions but received 4." Updated all mock providers/embeddings to 768-dim.
- **better-sqlite3 binds JS numbers as REAL** — vec0 rowid/metadata columns require genuine INTEGER, so bind rowid as `BigInt` (or `CAST(? AS INTEGER)`).
- The `search-searcher.test.ts` in drone-swarm-common was kept (it only tests the retained `dedupeAndCombineChunks`), not deleted as the plan's Step 7 wording suggested.
