---
key: plan-bit-prefilter-semantic-search
tags:
  - plan
  - drone-beacon
  - semantic-search
  - vector-index
created: 2026-09-01T19:47:58.822Z
updated: 2026-09-01T19:47:58.822Z
---

# Plan: Bit-Signature Prefilter for Beacon Semantic Search

**Plan key**: plan-bit-prefilter-semantic-search · **Grilled**: 2026-09-01 · **Status**: ready for execution
**Execution branch**: create `feat/bit-signature-prefilter` from current HEAD (feat/swarm-memory-rag is clean/landed)

## Summary

Add a 768-bit binary-signature prefilter to the beacon's workspace semantic index (the user's "Sphere(v)" idea). Each `search_chunks` embedding gets a 96-byte sign-quantized signature mirrored into a new sqlite-vec vec0 table `vec_chunks_bq`. Queries run cheap integer-Hamming KNN over signatures, rescore the shortlist with exact cosine in JS, and fall back to the existing float-KNN path only when the bit stage structurally under-delivers. Scope: workspace index (`search_chunks`/`vec_chunks`) ONLY; the wiki stack (`wiki_chunks`/`wiki_vec_chunks`) is an explicit phase-2 port once stable — motivated by expected wiki-corpus growth.

## S0 spike — verified platform facts (trust these; do not re-derive)

Verified live against the exact pinned binary (`sqlite-vec-linux-x64@0.1.9` vec0.so, `vec_version()` = v0.1.9):

1. `vec0` supports `BIT[768]` columns; MATCH+k KNN works on them; distance is integer Hamming (implicit — do NOT declare `distance_metric=hamming`, it is a vec0 constructor parse error on 0.1.9). Declare the column bare: `sig BIT[768]`.
2. `vec_quantize_binary(x)`: float32/int8 input only, length divisible by 8 (768 ✓ → 96 bytes), returns a raw headerless LSB-first packed-bits BLOB.
3. CRITICAL gotcha: bare BLOB bindings to BIT columns are misread as float32. Every bit value must be produced inside SQL (`vec_quantize_binary(?)` receiving the raw float32 buffer) or wrapped in `vec_bit(?)`. Never bind a JS-packed bit Buffer directly.
4. Elegant write path (verified): `INSERT INTO vec_chunks_bq(rowid, sig) VALUES (?, vec_quantize_binary(?))` binding the float32 buffer directly — zero JS bit math anywhere.
5. `vec_distance_hamming()` exists (not needed for v1; KNN supplies distances).
6. Combined schema also verified: `vec0(embedding FLOAT[768] distance_metric=cosine, sig BIT[768])` — both columns independently KNN-queryable. (We use a separate table to mirror the existing `vec_chunks` idiom.)

## Grilled decisions

1. **Scope**: workspace only now; wiki phase-2 later once stable.
2. **Signature fn**: identity sign quantization via inline `vec_quantize_binary` — no rotation. Seeded-rotation SimHash is a documented future escalation (trigger: recall harness regression).
3. **Over-fetch**: `const BIT_OVERFETCH = 8` hardcoded in the route (ADR 129 opinionated-constant precedent, no config knob). Calibration may adjust the constant later.
4. **Query path**: new db-layer fn `searchChunksByVectorPrefiltered` (bit KNN → join → JS cosine rescore, same result shape as `searchChunksByVector`). `rescoreByCosine` helper lives in `drone-swarm-common/src/search-searcher.ts` beside `dedupeAndCombineChunks` for wiki reuse. Route keeps an identical-shape fallback to the existing float path.
5. **Migration/fallback**: `backfillBqVecChunks()` mirrors `backfillVecChunks()` (no-op when bit table populated), wired at startup next to the existing backfill. `insertChunk` wraps chunk + float-mirror + bit-mirror in ONE `db.transaction` (strictly improves today's non-transactional two-write status quo). Route fallback triggers ONLY on bit-stage under-delivery (bit KNN returned fewer rows than requested k). Directory scoping in the prefiltered path = post-join filter (same semantics as the existing float path).
6. **Harness**: fast-suite — (a) exact-parity gate: seeded corpus, prefiltered top-k ordering identical to float path; (b) anisotropic recall gate: ~3000 synthetic 768-dim vectors with a dominant direction, rescored top-10 ≡ brute-force top-10 (recall@10 = 1.0) and |top50 ∩ truth| ≥ 49 at ×8. Anisotropy doubles as seeded-rotation early warning. Real-corpus calibration = documented follow-up in the ADR.

## Steps

### S1 — Schema (`drone-beacon/src/db/init.ts`)
After the existing `vec_chunks` creation (~line 201), add:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks_bq USING vec0(
  sig BIT[768]
);
```
No `distance_metric` option (parse error on 0.1.9; hamming is implicit for BIT columns).

### S2 — Write path + backfill (`drone-beacon/src/db/search.ts`)
- `insertChunk`: wrap the three writes in one `db.transaction`:
```ts
const tx = db.transaction(() => {
  const info = insertChunkStmt.run(id, directoryPath, filePath, chunkIndex, text, buffer);
  insertVec.run(BigInt(info.lastInsertRowid), buffer);
  insertBq.run(BigInt(info.lastInsertRowid), buffer); // 'INSERT INTO vec_chunks_bq(rowid, sig) VALUES (?, vec_quantize_binary(?))'
});
tx();
```
  (The bit insert binds the same float32 `Buffer`; `vec_quantize_binary` runs inside SQL. Keep BigInt rowid binding — existing gotcha.)
- `deleteChunksForFile` and `removeFilesByDirectory`: extend the rowid loops to also `DELETE FROM vec_chunks_bq WHERE rowid = ?`.
- New `backfillBqVecChunks(): number` — mirror of `backfillVecChunks`: no-op if `vec_chunks_bq` has rows; else `SELECT rowid, embedding FROM search_chunks`, insert via `vec_quantize_binary(?)` in one transaction, return count.

### S3 — Shared helper (`drone-swarm-common/src/search-searcher.ts` + its test file)
Add pure, dependency-free:
```ts
export function rescoreByCosine<T extends { embedding: Buffer }>(
  queryEmbedding: Float32Array,
  rows: T[]
): Array<T & { score: number }>
```
- Decode each embedding as float32: `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)`; score = dot / (‖q‖·‖v‖); sort desc. JSDoc the buffer format assumption.
- Unit tests: parallel → 1, orthogonal → 0, opposite → −1, correct float32 decode.
- Re-export from `src/index.ts` if the barrel enumerates exports.
- AFTER this step run `pnpm -r run build` before trusting beacon LSP (dependent packages resolve types from dist/).

### S4 — Prefiltered query fn (`drone-beacon/src/db/search.ts`)
Add `searchChunksByVectorPrefiltered(queryEmbedding: Float32Array, k: number, directoryPath?: string)` returning the SAME shape as `searchChunksByVector` (`{directoryPath, filePath, chunkIndex, text, score}[]`):
```sql
SELECT c.directory_path, c.file_path, c.chunk_index, c.text, c.embedding
FROM vec_chunks_bq v
JOIN search_chunks c ON c.rowid = v.rowid
WHERE v.sig MATCH vec_quantize_binary(?) AND c.directory_path = ?  -- filter omitted when unscoped
AND k = ?
```
- Params: raw float32 query buffer, optional directory, k. Import `rescoreByCosine` from `drone-swarm-common` (root package specifier — ADR 179 vitest resolution note). Rescore all returned candidates, sort desc, return. Row count = bit-KNN row count (rescore never drops), so `rows.length < k` is exactly the bit-stage under-delivery signal.
- Leave `searchChunksByVector` untouched (it is the fallback path).

### S5 — Route wiring (`drone-beacon/src/routes/search.ts`)
- Add `const BIT_OVERFETCH = 8;` beside `OVERFETCH_FACTOR = 4` with a comment citing ADR 181 (opinionated constant, calibration-adjustable).
- In `GET /agents/:id/search`: `const maxResultsVal = maxResults ?? 50; const bitK = maxResultsVal * BIT_OVERFETCH;`
- `let candidates = db.searchChunksByVectorPrefiltered(queryEmbedding, bitK, directoryPath);`
- `if (candidates.length < bitK) candidates = db.searchChunksByVector(queryEmbedding, maxResultsVal * OVERFETCH_FACTOR, directoryPath);`
- Downstream pipeline (minScore → isExcluded → dedupeAndCombineChunks) unchanged.

### S6 — Startup wiring (`drone-beacon/src/index.ts`, ~line 252)
Next to the existing `backfillVecChunks()` call + log, add `backfillBqVecChunks()` + analogous `logger.info`.

### S7 — Tests
- `drone-beacon/test/db-search.test.ts` (extend existing vec0-mirror describes): insertChunk mirrors into vec_chunks_bq (bit-KNN round-trip with `vec_quantize_binary(?)` query returns the rowid); deleteChunksForFile/removeFilesByDirectory clean bit rows; backfillBqVecChunks copies + no-op when populated; prefiltered top-k ordering identical to `searchChunksByVector` on a seeded corpus (parity); prefiltered returns < k rows when corpus < k (fallback condition).
- New `drone-beacon/test/bq-recall.test.ts` (the Q6 harness): seed ~3000 synthetic 768-dim normalized Float32Arrays with a dominant direction (`v = normalize(3·u + noise)`, per-dim σ varied so a few dims dominate — seeded PRNG, deterministic); 5 sampled queries; brute-force cosine ground truth; assert rescored top-10 ≡ brute-force top-10 (recall@10 = 1.0) and |rescored top50 ∩ truth| ≥ 49 at bitK = 50×8 = 400. Wrap bulk seeding in one transaction for speed.
- `drone-beacon/test/routes.test.ts`: one app.inject test — wipe `vec_chunks_bq` (simulate lost mirror), query `GET /agents/:id/search`, expect 200 + correct results via the float fallback.
- No changes to any `wiki*` file (scope gate).

### S8 — ADR 181 + wiki rows (Obsidian vault, `/home/unleet/Obsidian/drone-agent-project/`)
- `decisions/181-bit-signature-prefilter-semantic-search.md`: Context (Sphere(v) idea, brute-force vec0, wiki-corpus growth motivation, spike facts incl. the three 0.1.9 specifics), Decision (the six grilled decisions), Alternatives considered (seeded rotation now — deferred pending harness regression; wiki stack now — deferred until stable; dedicated ANN engine — wrong scale), Consequences + follow-ups (real-corpus calibration before trusting ×8 at 10× scale; wiki phase-2 port copies the idiom; escalation = seeded-rotation re-mirror via the backfill seam).
- Update `decisions/index.md` (row + count 180→181), `index.md` (latest pointer), `concepts/semantic-search.md` (prefilter subsection), `modules/drone-beacon.md` (key-files row).

### S9 — Validation sweep (final step)
Run the full Validation Criteria below; fix and re-run until green; then commit on the feature branch (check in `.drone-agent` memory/insight changes too — never commit to main).

## Validation criteria

1. **LSP**: zero errors/warnings in all touched files (`drone-beacon/src/db/init.ts`, `src/db/search.ts`, `src/index.ts`, `src/routes/search.ts`, `drone-swarm-common/src/search-searcher.ts` + tests).
2. **Build**: `pnpm -r run build` passes with zero errors (mandatory after S3 — beacon resolves drone-swarm-common types from dist/).
3. **Lint**: `pnpm -r run lint` (eslint + prettier) passes; re-read files after prettier before any further edit.
4. **Fast suite**: `pnpm -r run test` fully green, including the new mirror/parity/recall/fallback tests.
5. **Gates**: exact-parity test proves prefiltered ≡ float ordering on seeded corpus; recall@10 = 1.0 and recall@50 ≥ 0.98 on the anisotropic synthetic corpus at ×8; fallback test proves lost-bit-mirror queries still return correct results (200 + expected files).
6. **Scope**: no modifications under any wiki-related source file.
7. **Standards**: new code fully covered by tests; no dead code; jsdoc on exported functions only; files stay under 750 lines.

## Explicit follow-ups (out of scope)

- Real-corpus calibration of BIT_OVERFETCH (ADR note; before trusting at 10× scale).
- Wiki phase-2: `wiki_vec_chunks_bq` + `searchWikiChunksByVectorPrefiltered` + `GET /wiki/semantic-search` wiring, copying this idiom.
- Seeded-rotation SimHash escalation if the recall harness regresses.