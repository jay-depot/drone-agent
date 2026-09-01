import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { setupDb, teardownDb } from './setup.js';
import {
  insertChunk,
  searchChunksByVectorPrefiltered,
  getDatabase,
} from '../src/db/index.js';

// Deterministic PRNG (mulberry32) so the anisotropic corpus is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIM = 768;
const CORPUS_SIZE = 3000;
const TOPIC_COUNT = 8;
const CORPUS_SEED = 42;
const QUERY_COUNT = 5;
const QUERY_SEED = 1337;
// Query k = 50, overfetch multiplier 8 → shortlist 400 (mirrors the route's
// BIT_OVERFETCH constant; see ADR 181).
const TOP_K = 50;
const BIT_OVERFETCH = 8;

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

// Shared dominant direction: real embedding corpora are anisotropic — every
// vector carries a large common component, so raw cosine similarities are all
// high and rankings hinge on the residual structure.
const DOMINANT = (() => {
  const rand = mulberry32(7);
  const u = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) u[i] = rand() * 2 - 1;
  return normalize(u);
})();

// Topic centroids occupy disjoint 96-dim slices, so same-topic vectors agree
// on ~96 sign bits that cross-topic pairs flip — this is what makes Hamming
// distance informative about cosine under sign quantization.
const TOPICS = (() => {
  const rand = mulberry32(99);
  const topics: Float32Array[] = [];
  for (let t = 0; t < TOPIC_COUNT; t++) {
    const c = new Float32Array(DIM);
    for (let d = 0; d < 96; d++) {
      c[t * 96 + d] = rand() * 2 - 1;
    }
    topics.push(normalize(c));
  }
  return topics;
})();

/**
 * Corpus vector: normalize(3·dominant + topic + noise). Noise is small
 * (uniform ±0.05 per dim ≈ norm 0.8) so the shared dominant direction and the
 * topic component carry most of the energy — the anisotropic regime where
 * sign quantization is known to lose the most information.
 */
function corpusVector(topic: Float32Array, rand: () => number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) {
    const noise = (rand() * 2 - 1) * 0.05;
    v[i] = 3 * DOMINANT[i] + topic[i] + noise;
  }
  return normalize(v);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function topKByBruteForce(
  query: Float32Array,
  corpus: Float32Array[],
  k: number
): Set<number> {
  return new Set(
    corpus
      .map((v, i) => ({ i, score: cosine(query, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(r => r.i)
  );
}

describe('bit-signature prefilter recall (anisotropic corpus)', () => {
  const corpus: Float32Array[] = [];
  const queries: Float32Array[] = [];

  beforeEach(async () => {
    await setupDb();
    corpus.length = 0;
    queries.length = 0;
    const rand = mulberry32(CORPUS_SEED);
    for (let i = 0; i < CORPUS_SIZE; i++) {
      corpus.push(corpusVector(TOPICS[i % TOPIC_COUNT], rand));
    }
    const qrand = mulberry32(QUERY_SEED);
    for (let i = 0; i < QUERY_COUNT; i++) {
      // Queries are corpus vectors with a small perturbation — the realistic
      // "user query near a relevant doc" shape. The perturbation stays small
      // (±0.015 per dim ≈ norm 0.24) so the query keeps a well-defined
      // nearest-topic neighborhood.
      const base = corpus[Math.floor(qrand() * CORPUS_SIZE)];
      const q = new Float32Array(DIM);
      for (let i = 0; i < DIM; i++) {
        q[i] = base[i] + (qrand() * 2 - 1) * 0.015;
      }
      queries.push(normalize(q));
    }
  });

  afterEach(async () => {
    await teardownDb();
  });

  it('recall@10 = 1.0 and recall@50 ≥ 0.98 at ×8 overfetch', async () => {
    // Bulk-seed in one transaction so the 3000-row insert stays fast.
    const db = getDatabase();
    const insertAll = db.transaction((vecs: Float32Array[]) => {
      vecs.forEach((vec, i) => {
        insertChunk('/recall', `/recall/doc-${i}.ts`, 0, `chunk ${i}`, vec);
      });
    });
    insertAll(corpus);

    const bitK = TOP_K * BIT_OVERFETCH; // 400
    let recall10Sum = 0;
    let recall50Sum = 0;
    for (const q of queries) {
      const truth10 = topKByBruteForce(q, corpus, 10);
      const truth50 = topKByBruteForce(q, corpus, TOP_K);
      const rescored = searchChunksByVectorPrefiltered(q, bitK);

      const top10 = new Set(rescored.slice(0, 10).map(r => r.filePath));
      let hits10 = 0;
      for (const i of truth10) {
        if (top10.has(`/recall/doc-${i}.ts`)) hits10++;
      }
      recall10Sum += hits10 / 10;

      const top50 = new Set(rescored.slice(0, TOP_K).map(r => r.filePath));
      let hits50 = 0;
      for (const i of truth50) {
        if (top50.has(`/recall/doc-${i}.ts`)) hits50++;
      }
      recall50Sum += hits50 / TOP_K;
    }
    const meanRecall10 = recall10Sum / queries.length;
    const meanRecall50 = recall50Sum / queries.length;
    expect(meanRecall10).toBe(1.0);
    expect(meanRecall50).toBeGreaterThanOrEqual(0.98);
  });
});
