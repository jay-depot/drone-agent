---
key: plan-sqlite-vec-semantic-search
tags: []
created: 2026-08-14T06:41:52.571Z
updated: 2026-08-14T06:41:52.571Z
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

### Step 1 — Add sqlite-vec dependency to the beacon _(coder)_

**File:** `drone-beacon/package.json`

Add `sqlite-vec` (pin exact version, e.g. `0.1.9`). It's a native-extension package with prebuilt binaries.

### Step 2 — Load the extension in DB init _(coder)_

**File:** `drone-beacon/src/db/init.ts`

In `initDatabase()`, after `new Database(dataPath)`, call `sqliteVec.load(db)`. Add the `vec_chunks` vec0 table to the schema:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  embedding FLOAT[768] distance_metric=cosine
);
```

Note: verify sqlite-vec supports `CREATE VIRTUAL TABLE IF NOT EXISTS` (it should).

### Step 3 — Add vec0 write helpers to `db/search.ts` _(coder)_

**File:** `drone-beacon/src/db/search.ts`

- `insertChunk`: after inserting into `search_chunks`, capture `lastInsertRowid` and mirror into `vec_chunks` with `BigInt(rowid)`.
- `deleteChunksForFile`: after deleting from `search_chunks`, delete matching rows from `vec_chunks` by rowid (select rowids first, or use a subquery).
- `removeFilesByDirectory`: same — delete vec0 rows for the directory's chunks.
- Add a `searchChunksByVector(queryEmbedding, k)` helper that runs the vec0 KNN query and joins back to `search_chunks`.

### Step 4 — Update the search route to use vec0 _(coder)_

**File:** `drone-beacon/src/routes/search.ts`

Replace the `getAllChunks` + JS cosine loop with:

1. `provider.getEmbedding('search_query: ' + q)`.
2. `db.searchChunksByVector(queryEmbedding, maxResults × OVERFETCH_FACTOR)` → returns `{ filePath, chunkIndex, text, score }` (score = `1 - distance`).
3. Apply `isExcluded` globs.
4. `dedupeAndCombineChunks(scored, { maxResults })`.
5. Return the same response shape.

### Step 5 — Backfill migration _(coder)_

**File:** `drone-beacon/src/db/search.ts` (or a migration helper)

A one-time function that copies existing `search_chunks` embeddings into `vec_chunks` (using their implicit rowids), run in a transaction. Called on startup if `vec_chunks` is empty and `search_chunks` has rows.

### Step 6 — Tests _(tester)_

- `drone-beacon/test/db/search.test.ts` (new or extended): `insertChunk` mirrors into vec0; `deleteChunksForFile`/`removeFilesByDirectory` clean up vec0; `searchChunksByVector` returns correct results ordered by distance.
- `drone-beacon/test/routes.test.ts`: update the search route tests to verify vec0-backed results (same response shape, dedup, exclude).
- Verify the existing `semanticSearch`/`SearchStore` tests still pass (unchanged, test-only).

### Step 7 — Remove dead code (`SearchStore`/`semanticSearch`/`cosineSimilarity`) _(coder)_

- Delete `drone-swarm-common/src/search-store.ts`.
- In `drone-swarm-common/src/search-searcher.ts`, remove `SearchStore` import, `SearchOptions`, `semanticSearch`, `cosineSimilarity`, and the `SearchChunkRow` usage. **Keep `ScoredChunk`, `dedupeAndCombineChunks`, `DedupeOptions`, `SearchResult`.**
- Update `drone-swarm-common/src/index.ts` exports (remove `search-store.js`).
- Delete `drone-swarm-common/test/search-searcher.test.ts` (only tests `dedupeAndCombineChunks` — move those cases into a new `dedupe` test file or keep a trimmed version).
- Update `drone-agent/test/search.test.ts`: remove the `SearchStore`/`semanticSearch` describe blocks and the `SearchStore`/`semanticSearch` imports.

### Step 8 — Review _(reviewer)_

Check correctness, dead code, and that all consumers of the beacon search route are covered (agent-side passes through the beacon response). Verify no remaining references to removed symbols.

### Step 9 — Validation _(coder)_

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
