---
tags: [decision, semantic-search, sqlite-vec, binary-quantization, lsh, vector-index, drone-beacon]
related: [concepts/semantic-search.md, decisions/179-swarm-memory-rag-retrieval.md, decisions/150-semantic-search-prompt-surface.md, modules/drone-beacon.md, modules/drone-swarm-common.md]
---

# 181 — Bit-signature prefilter for beacon semantic search

**Date**: 2026-09-01 · **Status**: Accepted · **Branch**: `feat/bit-signature-prefilter`

## Context

The beacon's semantic search (ADR 179's sibling: workspace `search_chunks`/`vec_chunks`) runs brute-force cosine KNN through sqlite-vec's vec0 virtual table — every query scans every 768-dim float32 embedding (3072 bytes each). The user's "Sphere(v)" idea — map embeddings so a cheap distance prefilters before exact cosine — is the classic SimHash/spherical-LSH family (Charikar 2002; Terasawa & Tanaka 2007; binary-quantize-then-rescore as shipped by Qdrant/RaBitQ): L2-normalize → sign-quantize into a D-bit signature; Pr[bits agree] = 1 − θ/π makes Hamming distance a monotone proxy for angle, and oversampled recall fixes the quantization loss.

A live spike against the pinned `sqlite-vec-linux-x64@0.1.9` vec0.so verified the whole bit stack works on the version we already ship:

1. `vec0` supports `BIT[768]` columns with MATCH+k KNN; distance is integer Hamming, implicit for BIT columns (declaring `distance_metric=hamming` is a 0.1.9 constructor parse error).
2. `vec_quantize_binary(x)` takes float32/int8 (length divisible by 8; 768 → 96 bytes) and returns a raw headerless LSB-first packed-bits BLOB.
3. **Critical gotcha**: bare BLOB bindings to BIT columns are misread as float32 — every bit value must be produced inside SQL (`vec_quantize_binary(?)` fed the raw float32 buffer) or wrapped in `vec_bit(?)`. Never bind a JS-packed bit Buffer directly.
4. A combined schema `vec0(embedding FLOAT[768] distance_metric=cosine, sig BIT[768])` is queryable on both columns independently (we still use a separate table to mirror the existing `vec_chunks` idiom).

Motivation is the wiki corpus's expected growth (the workspace index is the proving ground; `wiki_chunks`/`wiki_vec_chunks` port is phase 2 once stable).

## Decision

**Scope — workspace index only.** `search_chunks`/`vec_chunks` get the bit mirror; the wiki stack is an explicit phase-2 port.

**Signature — identity sign quantization, zero JS bit math.** `vec_quantize_binary` runs inline in SQL; no random rotation. Seeded-rotation SimHash is a documented escalation only.

**Write path — one transaction, three writes.** `insertChunk` now wraps `search_chunks` + `vec_chunks` + `vec_chunks_bq` in a single `better-sqlite3` transaction (strictly improves the previous non-transactional two-write status quo). The bit insert is `INSERT INTO vec_chunks_bq(rowid, sig) VALUES (?, vec_quantize_binary(?))` binding the same float32 Buffer. `deleteChunksForFile`/`removeFilesByDirectory` extend their rowid loops to clean the bit table, and `backfillBqVecChunks()` (mirror of `backfillVecChunks`: no-op when the bit table has rows) runs at startup next to the existing backfill.

**Query path — prefilter + rescore, identical result shape.** New db-layer `searchChunksByVectorPrefiltered(queryEmbedding, k, directoryPath?)`: bit KNN over `vec_chunks_bq` → rowid-join to `search_chunks` → exact-cosine rescore in JS via the shared `rescoreByCosine` helper (`drone-swarm-common/src/search-searcher.ts`, beside `dedupeAndCombineChunks`, for wiki reuse). The bit-KNN Hamming distances are deliberately discarded; rescoring never drops rows, so `rows.length < k` is exactly the bit-stage under-delivery signal. Directory scoping is a post-join filter, same semantics as the float path.

**Over-fetch — opinionated constant.** `const BIT_OVERFETCH = 8` in the route (ADR 129 opinionated-constant precedent, no config knob): the Hamming shortlist is `maxResults × 8` rows, rescored to exact cosine before the unchanged minScore → exclude → dedupe pipeline. The route falls back to the existing float KNN path (`maxResults × OVERFETCH_FACTOR`) ONLY when the bit stage structurally under-delivers (bit KNN returned fewer rows than requested k) — e.g. lost mirror or corpus smaller than k.

**Harness — fast-suite recall gates.** (a) Exact-parity: seeded corpus, prefiltered top-k ordering and scores identical to the float path. (b) Anisotropic recall: ~3000 synthetic 768-dim vectors, `v = normalize(3·u + topic + noise)` with a shared dominant direction and topic-structured residuals, 5 deterministic queries; recall@10 = 1.0 and recall@50 ≥ 0.98 at bitK = 400 (50 × 8). Bulk seeding in one transaction.

**Harness-construction finding worth keeping**: sign quantization only carries signal when similarity is expressed through *shared sign patterns*. A corpus where each vector has its own random dominant dimension yields ~50% random sign agreement in every dim — Hamming distance stops predicting cosine (measured recall 0.52 ≈ random). The harness therefore models real embedding corpora: global anisotropy + topic centroids on disjoint dim-slices + small noise, giving ~4.5σ separation between same-topic and cross-topic Hamming.

## Alternatives considered

- **Seeded-rotation SimHash now** — deferred. Identity sign quantization is simpler and the recall harness doubles as the early-warning tripwire; if it regresses, re-mirror via the backfill seam with a rotated quantizer.
- **Port the wiki stack now** — deferred until the idiom is stable on the workspace index; the wiki corpus is the growth-motivated end goal.
- **A dedicated ANN engine (HNSW etc.)** — wrong scale: vec0 is already brute-force, and the payoff point for a separate engine is ~1M+ chunks; binary prefilter is the proportionate sibling step.

## Consequences

- Every chunk write now costs one extra 96-byte insert inside the same transaction; storage grows by 96 bytes/chunk (12.5% of the float32 payload) while the prefilter query path touches 8×-shortlisted 96-byte signatures instead of full float32 rows before rescoring only the shortlist in JS.
- The fallback is structural, not heuristic: it triggers exactly when the bit stage returns fewer rows than requested, so a lost or unpopulated mirror degrades to today's behavior, never to wrong results (pinned by a route-level test that wipes `vec_chunks_bq`).
- `insertChunk` is now atomic across all three stores — a crash mid-write can no longer strand a float-mirrored chunk without its bit mirror (or vice versa).
- **Follow-up: real-corpus calibration before trusting ×8 at 10× scale.** The synthetic harness gates regressions; it does not prove 8 is the right multiplier for nomic-embed-text's actual corpus. Calibration may adjust the constant (code seam is one `const` in the route).
- **Follow-up: wiki phase-2 port** — `wiki_vec_chunks_bq` + `searchWikiChunksByVectorPrefiltered` + `GET /wiki/semantic-search` wiring, copying this idiom; `rescoreByCosine` already lives in `drone-swarm-common` for exactly that reuse.
- **Escalation path**: if the recall harness regresses (anisotropy shift, model change), the seeded-rotation SimHash re-mirror goes through the same backfill seam with no schema change.

## Related

- [[concepts/semantic-search]] — the vector index this prefilter sits in front of
- [[decisions/179-swarm-memory-rag-retrieval]] — the wiki stack awaiting the phase-2 port
- [[modules/drone-beacon]] · [[modules/drone-swarm-common]] — `rescoreByCosine` lives beside `dedupeAndCombineChunks`