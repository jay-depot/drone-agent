---
key: plan-dedupe-semantic-search-results
tags: []
created: 2026-08-14T05:39:27.021Z
updated: 2026-08-14T05:45:15.792Z
---

---

key: plan-dedupe-semantic-search-results
tags: [search, semantic-search, dedup, beacon, drone-swarm-common]
created: 2026-08-14T00:00:00.000Z
updated: 2026-08-14T00:00:00.000Z

---

# Plan: Deduplicate Semantic Search Results by File

## Summary

Deduplicate semantic search results so each file appears at most once. For each file, keep the highest-scoring chunk's `score`/`chunkIndex` for ranking, but combine the text of all matching chunks into the result's `content`, inserting a clear gap marker (`[...]`) between non-consecutive chunks. The dedup+combine logic lives in a shared pure function in `drone-swarm-common`, used by both the `semanticSearch` helper and the beacon search route.

## Context

With structure-aware chunking (plan-structure-aware-chunking), a single file now produces many chunks, so a query matching several chunks from the same file returns that file multiple times (once per matching chunk). The fix is file-level dedup keeping the best chunk's score, combining the matching chunks' text, with a gap marker when chunks are non-consecutive.

## Design decisions

1. **Shared pure function** `dedupeAndCombineChunks(scored, { maxResults, maxCombinedChars })` in `drone-swarm-common/src/search-searcher.ts` — dedups by file, keeps best score, combines texts with gap markers, caps combined size, slices to `maxResults` files.
2. **`semanticSearch`** calls it after scoring (reusable by coordinator's future wiki search).
3. **Beacon route** calls it after its own scoring + exclude filtering (keeps exclude support, no storage refactor). This is the "spirit of B": the dedup logic is shared, but the beacon doesn't literally call `semanticSearch` (which would require a risky storage-layer refactor since the beacon uses `db.*` and has exclude filtering).
4. **Gap marker**: `[...]` on its own line between non-consecutive chunks (consecutive chunks join with a blank line, no marker).
5. **Combined-size cap**: `maxCombinedChars = 8000` default (safety bound so a file with many matching chunks doesn't bloat the response).
6. **Ranking**: entry's `score`/`chunkIndex` come from the best chunk; combined text is the payload.
7. **`resultCount`/`truncated`** now reflect unique files, not chunks.

## Steps

### Step 1 — Add `dedupeAndCombineChunks` to `drone-swarm-common` _(coder)_

**File:** `drone-swarm-common/src/search-searcher.ts`

Add a `ScoredChunk` type (`{ filePath, chunkIndex, text, score }`) and a pure `dedupeAndCombineChunks(scored, { maxResults, maxCombinedChars = 8000 })`:

- Group by `filePath`.
- Per file: sort chunks by `chunkIndex`; find best (highest `score`); combine texts — join consecutive chunks with `\n\n`, insert `\n\n[...]\n\n` between non-consecutive chunks; cap combined text at `maxCombinedChars` (append `\n…` if truncated).
- Return one entry per file (`{ filePath, chunkIndex: best.chunkIndex, text: combined, score: best.score }`), sorted by score desc, sliced to `maxResults`.

### Step 2 — Update `semanticSearch` to use it _(coder)_

**File:** `drone-swarm-common/src/search-searcher.ts`

After scoring + sorting, call `dedupeAndCombineChunks(scored, { maxResults })` instead of the current `slice(0, maxResults)` + map.

### Step 3 — Update the beacon route to use it _(coder)_

**File:** `drone-beacon/src/routes/search.ts`

After the exclude-filtered scoring loop, map rows to `ScoredChunk`, call `dedupeAndCombineChunks`, then map back to the response shape. Update `resultCount` to `top.length` (unique files) and `truncated` to `top.length >= maxResults`.

### Step 4 — Tests _(tester)_

- `drone-swarm-common/test/search-searcher.test.ts` (new): `dedupeAndCombineChunks` dedups by file, keeps best score, combines consecutive chunks without gap marker, inserts `[...]` for non-consecutive chunks, caps combined size, respects `maxResults`.
- Update `drone-agent/test/search.test.ts` `semanticSearch` tests: the "returns results sorted" test currently expects 3 results (2 files) — after dedup it should expect 2 (one per file). Verify the combined text and best-score behavior.
- `drone-beacon/test/routes.test.ts`: add a test that `GET /agents/:id/search` returns one result per file (seed two chunks from the same file, assert one entry with combined content).

### Step 5 — Review _(reviewer)_

Check correctness, dead code, and that all consumers of `semanticSearch` and the beacon search route are covered (agent-side `handleSemanticSearch` and `/search-files` pass through the beacon response, so no change needed there).

### Step 6 — Validation _(coder)_

Run the full validation criteria below.

## Validation criteria

1. **LSP diagnostics clean** for all touched files (no new errors; pre-existing branch diagnostics in `drone-agent/test/search.test.ts` and `prompt-file.test.ts` are out of scope).
2. `pnpm -r run build` passes (run **before** relying on LSP in `drone-beacon`, since it resolves `drone-swarm-common` from `dist/`).
3. `pnpm -r run typecheck` passes.
4. `pnpm -r run lint` passes.
5. `pnpm -r run test` passes (fast suite).
6. New dedup logic covered by unit tests (Step 4).
7. No dead code / unused imports.

## Future work (not in this plan)

- Coordinator wiki semantic search (reuses `semanticSearch` + `dedupeAndCombineChunks`).
- Small-to-big / parent-document retrieval (embed small units, expand to enclosing class/file for the model).

---

## Execution Summary (completed 2026-08-14 by code persona)

All 6 steps implemented and validated. Commit: `9bae956`.

- **Step 1**: Added `ScoredChunk` type and `dedupeAndCombineChunks(scored, { maxResults, maxCombinedChars = 8000 })` to `drone-swarm-common/src/search-searcher.ts`. Groups by file, keeps the best chunk's score/chunkIndex for ranking, combines texts (consecutive chunks joined with `\n\n`, non-consecutive separated by `\n\n[...]\n\n`), caps combined text at `maxCombinedChars` (appends `\n…` if truncated), sorts by score desc, slices to `maxResults`.
- **Step 2**: `semanticSearch` now builds `ScoredChunk[]` during scoring and returns `dedupeAndCombineChunks(scored, { maxResults })` instead of the old `slice` + map.
- **Step 3**: The beacon `/agents/:id/search` route now maps its exclude-filtered scored rows to `ScoredChunk`, calls `dedupeAndCombineChunks(scored, { maxResults: maxResults ?? 50 })`, and maps back to the response shape. `resultCount`/`truncated` now reflect unique files.
- **Step 4**: Added `drone-swarm-common/test/search-searcher.test.ts` (6 cases: dedup by file + best score, consecutive combine without gap marker, non-consecutive gap marker, size cap, maxResults, sort by score). Updated the `semanticSearch` "returns results sorted" test to expect 2 files (was 3 chunks) with combined text. Added a beacon route test seeding two chunks from the same file and asserting one combined result.
- **Step 5**: Review — `semanticSearch` is only used in tests (beacon uses `dedupeAndCombineChunks` directly, the intended "spirit of B"); agent-side `handleSemanticSearch`/`/search-files` pass through the beacon response, no change needed. Removed the now-unused `SearchChunkRow` import (caught by lint).
- **Step 6**: Validation all green — LSP clean on touched files (pre-existing `currentDirs` hint in routes/search.ts and `search.test.ts` module-resolution error unchanged); `pnpm -r run build` ✓; `pnpm -r run typecheck` ✓; `pnpm lint` ✓; `pnpm test` ✓ (1911 passed, 9 skipped).

**Notable implementation details:**

- The beacon route keeps its own scoring + exclude filtering and calls `dedupeAndCombineChunks` directly (not `semanticSearch`), because `semanticSearch` takes a `SearchStore` and has no exclude support — forcing the beacon to use it would require a risky storage-layer refactor. The dedup logic is still shared in one place.
- The `SearchChunkRow` import became unused after the scoring loop switched to `ScoredChunk`; lint caught it and it was removed.
