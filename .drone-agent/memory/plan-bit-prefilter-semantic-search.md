---
key: plan-bit-prefilter-semantic-search
tags:
  - plan
  - drone-beacon
  - semantic-search
  - vector-index
created: 2026-09-01T19:47:58.822Z
updated: 2026-09-01T20:06:09.111Z
---

# Plan: Bit-Signature Prefilter for Beacon Semantic Search

**Plan key**: plan-bit-prefilter-semantic-search · **Grilled**: 2026-09-01 · **Status**: EXECUTED & LANDED (2026-09-01)

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
4. **Query path**: new db-layer fn `searchChunksByVectorPrefiltered` (bit KNN → join → JS cosine rescore, same result shape as `searchChaunksByVector`). `rescoreByCosine` helper lives in `drone-swarm-common/src/search-searcher.ts` beside `dedupeAndCombineChunks` for wiki reuse. Route keeps an identical-shape fallback to the existing float path.
5. **Migration/fallback**: `backfillBqVecChunks()` mirrors `backfillVecChunks()` (no-op when bit table populated), wired at startup next to the existing backfill. `insertChunk` wraps chunk + float-mirror + bit-mirror in ONE `db.transaction` (strictly improves today's non-transactional two-write status quo). Route fallback triggers ONLY on bit-stage under-delivery (bit KNN returned fewer rows than requested k). Directory scoping in the prefiltered path = post-join filter (same semantics as the existing float path).
6. **Harness**: fast-suite — (a) exact-parity gate: seeded corpus, prefiltered top-k ordering identical to float path; (b) anisotropic recall gate: ~3000 synthetic 768-dim vectors with a dominant direction, rescored top-10 ≡ brute-force top-10 (recall@10 = 1.0) and |top50 ∩ truth| ≥ 49 at ×8. Anisotropy doubles as seeded-rotation early warning. Real-corpus calibration = documented follow-up in the ADR.

## Steps

(Steps S1–S9 as originally planned — all executed as written; see the execution summary below for what landed.)

### S1 — Schema (`drone-beacon/src/db/init.ts`)
After the existing `vec_chunks` creation: `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks_bq USING vec0(sig BIT[768]);`

### S2 — Write path + backfill (`drone-beacon/src/db/search.ts`)
`insertChunk` wraps the 3-way write in one `db.transaction`; bit insert = `INSERT INTO vec_chunks_bq(rowid, sig) VALUES (?, vec_quantize_binary(?))` binding the float32 Buffer (BigInt rowid). `deleteChunksForFile`/`removeFilesByDirectory` extend their rowid loops to clean the bit table. `backfillBqVecChunks(): number` mirrors `backfillVecChunks` (no-op when populated).

### S3 — Shared helper (`drone-swarm-common/src/search-searcher.ts`)
`rescoreByCosine<T extends { embedding: Buffer }>(queryEmbedding, rows)` — float32 decode, cosine score (0 for zero vectors), sort desc, never drops rows. Barrel re-export confirmed (`export * from './search-searcher.js'`). Build run after this step.

### S4 — Prefiltered query fn (`drone-beacon/src/db/search.ts`)
`searchChunksByVectorPrefiltered(queryEmbedding, k, directoryPath?)` — bit KNN (`WHERE v.sig MATCH vec_quantize_binary(?) AND k = ?`, optional directory post-join filter) → rowid-join → `rescoreByCosine` → strip embedding → same result shape as the float fn. `searchChunksByVector` untouched.

### S5 — Route wiring (`drone-beacon/src/routes/search.ts`)
`BIT_OVERFETCH = 8` const (ADR 181 comment); `maxResultsVal = maxResults ?? 50`; prefiltered at `bitK = maxResultsVal * 8`; fallback to `searchChunksByVector(maxResultsVal * 4)` only when `candidates.length < bitK`. Downstream pipeline unchanged.

### S6 — Startup wiring (`drone-beacon/src/index.ts`)
`backfillBqVecChunks()` next to `backfillVecChunks()` with its own `logger.info`.

### S7 — Tests
- `db-search.test.ts`: 5 new vec_chunks_bq mirror tests + 3 prefiltered tests (parity w/ score closeness, directory scoping, <k fallback condition).
- `bq-recall.test.ts` (new): 3000-vector anisotropic corpus (global dominant direction + 8 topic centroids on disjoint 96-dim slices + small noise, mulberry32 PRNG), 5 queries, recall@10 = 1.0 + recall@50 ≥ 0.98 at bitK = 400. Bulk-seed transaction.
- `routes.test.ts`: wipe-`vec_chunks_bq` fallback test (200 + both files, deterministic via orthogonal second embedding).
- `search-searcher.test.ts`: 5 rescoreByCosine unit tests.
- No wiki* source files touched (scope gate verified via git status).

### S8 — ADR 181 + wiki
ADR written at `decisions/181-bit-signature-prefilter-semantic-search.md` (Context/Decision/Alternatives/Consequences incl. the harness-construction finding); decisions/index.md got rows in both tables + count 179→181; index.md latest pointer; concepts/semantic-search.md got a "Bit-Signature Prefilter" section; modules/drone-beacon.md + modules/drone-swarm-common.md rows updated. Vault commit 2f66004.

### S9 — Validation sweep results (all green)
- LSP: zero diagnostics on all 10 touched files.
- `pnpm -r run build` + `pnpm typecheck`: pass.
- `pnpm lint` (eslint + prettier): pass, no reformat churn.
- Fast suite via root `pnpm test`: 192 files, 2650 tests, all green. NOTE: `pnpm -r run test` fails at drone-core with "No test files found" (root vitest config paths don't resolve from package dirs) — verified PRE-EXISTING via git stash on the base commit; the root `pnpm test` script is the real gate (see insight).
- Scope: no wiki source files modified.
- Standards: files well under 750 lines (largest touched: db/search.ts 397).

## Execution summary (2026-09-01, branch feat/bit-signature-prefilter)

All steps S1–S9 executed exactly per plan. Deviations: two harness/test fixes only (both bugs in MY test code, not the pipeline): (1) routes fallback test initially expected deterministic order from two parallel embeddings (both cosine 1.0) — fixed with an orthogonal second embedding; (2) the anisotropic recall corpus was rebuilt from per-vector dominant dims (recall 0.52 ≈ random — sign patterns carried no signal) to global anisotropy + topic-structured residuals (recall@10 = 1.0, recall@50 = 0.98–1.0 at ×8). Both documented in ADR 181. Full suite green, LSP/build/lint clean, all gates pass. Wiki/doc updates committed to the Obsidian vault (2f66004); code committed on feat/bit-signature-prefilter.