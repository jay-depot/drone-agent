import { describe, expect, it } from 'vitest';

import {
  fuseMemoryResults,
  wikiKey,
  type MemoryFusionInput,
  type WikiCandidate,
} from '../src/memory-fusion.js';
import type { RankingConfig } from '../src/config-file.js';

const MAX_PITCH = 400;

function ranking(over: Partial<RankingConfig> = {}): RankingConfig {
  return {
    topK: 5,
    minScore: 0.35,
    keywordBoost: 0.08,
    anchors: { tags: [], boostPerTag: 0.08, boostTitle: 0.05 },
    ...over,
  };
}

function wiki(over: Partial<WikiCandidate> = {}): WikiCandidate {
  return {
    pageId: 'p1',
    origin: 'beacon',
    title: 'Page One',
    tags: [],
    score: 0.6,
    matchedChunk: 'chunk text',
    ...over,
  };
}

function fuse(input: Partial<MemoryFusionInput>) {
  return fuseMemoryResults(
    {
      wiki: [],
      files: [],
      ranking: ranking(),
      ...input,
    },
    MAX_PITCH
  );
}

describe('fuseMemoryResults', () => {
  describe('per-document MAX across inputs', () => {
    it('keeps the best score when a page appears in several inputs', () => {
      const out = fuse({
        wiki: [
          wiki({ pageId: 'p1', score: 0.5 }),
          wiki({ pageId: 'p1', score: 0.8 }),
          wiki({ pageId: 'p1', score: 0.65 }),
        ],
      });
      expect(out).toHaveLength(1);
      expect(out[0].score).toBeCloseTo(0.8);
    });

    it('treats the same pageId at different origins as distinct', () => {
      const out = fuse({
        wiki: [
          wiki({ pageId: 'dual', origin: 'beacon', score: 0.6 }),
          wiki({ pageId: 'dual', origin: 'coordinator', score: 0.7 }),
        ],
      });
      expect(out).toHaveLength(2);
    });
  });

  describe('keyword coverage boost', () => {
    it('adds keywordBoost * coverage to a wiki page', () => {
      const out = fuse({
        wiki: [wiki({ score: 0.6 })],
        coverage: new Map([[wikiKey('beacon', 'p1'), 1]]),
        ranking: ranking({ minScore: 0 }),
      });
      expect(out[0].score).toBeCloseTo(0.68);
    });

    it('scales partially with fractional coverage', () => {
      const out = fuse({
        wiki: [wiki({ score: 0.6 })],
        coverage: new Map([[wikiKey('beacon', 'p1'), 0.5]]),
        ranking: ranking({ minScore: 0 }),
      });
      expect(out[0].score).toBeCloseTo(0.64);
    });

    it('leaves a page with no coverage exactly at its cosine', () => {
      const out = fuse({
        wiki: [wiki({ score: 0.6 })],
        coverage: new Map([[wikiKey('beacon', 'other'), 1]]),
        ranking: ranking({ minScore: 0 }),
      });
      expect(out[0].score).toBeCloseTo(0.6);
    });

    it('does not boost file entries (the index is beacon-local)', () => {
      const out = fuse({
        files: [{ filePath: '/a.ts', score: 0.6, snippet: 'x' }],
        coverage: new Map([[wikiKey('beacon', '/a.ts'), 1]]),
        ranking: ranking({ minScore: 0 }),
      });
      expect(out[0].score).toBeCloseTo(0.6);
    });
  });

  describe('minScore is applied after fusion', () => {
    it('rescues a page whose cosine alone is below the floor', () => {
      const out = fuse({
        wiki: [wiki({ score: 0.3 })],
        coverage: new Map([[wikiKey('beacon', 'p1'), 1]]),
      });
      // 0.30 + 0.08 = 0.38 >= 0.35
      expect(out).toHaveLength(1);
      expect(out[0].score).toBeCloseTo(0.38);
    });

    it('still filters a page that stays below the floor', () => {
      const out = fuse({ wiki: [wiki({ score: 0.2 })] });
      expect(out).toEqual([]);
    });

    it('does not let a weak keyword match rescue a page', () => {
      // 0.30 + 0.08*0.25 = 0.32 < 0.35
      const out = fuse({
        wiki: [wiki({ score: 0.3 })],
        coverage: new Map([[wikiKey('beacon', 'p1'), 0.25]]),
      });
      expect(out).toEqual([]);
    });

    it('leaves pure-semantic results unchanged versus today', () => {
      const out = fuse({
        wiki: [wiki({ score: 0.5 }), wiki({ pageId: 'p2', score: 0.3 })],
      });
      expect(out).toHaveLength(1);
      const entry = out[0];
      if (entry.kind !== 'wiki') throw new Error('expected wiki entry');
      expect(entry.pageId).toBe('p1');
      expect(entry.score).toBeCloseTo(0.5);
    });
  });

  describe('cross-kind comparability (additive, not convex)', () => {
    it('does not scale wiki scores down against file scores', () => {
      const out = fuse({
        wiki: [wiki({ pageId: 'w', score: 0.7 })],
        files: [{ filePath: '/f.ts', score: 0.65, snippet: 'x' }],
        ranking: ranking({ minScore: 0 }),
      });
      // Without a convex coefficient the wiki page keeps its full cosine and
      // stays ahead of the weaker file hit.
      expect(out.map(e => (e.kind === 'wiki' ? e.pageId : e.filePath))).toEqual(
        ['w', '/f.ts']
      );
      expect(out[0].score).toBeCloseTo(0.7);
    });
  });

  describe('anchor boosts', () => {
    it('boosts a wiki page matching an anchor tag', () => {
      const out = fuse({
        wiki: [wiki({ tags: ['drone-beacon'], score: 0.5 })],
        ranking: ranking({
          minScore: 0,
          anchors: {
            tags: ['drone-beacon'],
            boostPerTag: 0.08,
            boostTitle: 0.05,
          },
        }),
      });
      expect(out[0].score).toBeCloseTo(0.58);
    });

    it('boosts a wiki page whose title contains an anchor', () => {
      const out = fuse({
        wiki: [wiki({ title: 'Beacon guide', score: 0.5 })],
        ranking: ranking({
          minScore: 0,
          anchors: { tags: ['beacon'], boostPerTag: 0.08, boostTitle: 0.05 },
        }),
      });
      expect(out[0].score).toBeCloseTo(0.55);
    });

    it('boosts a file entry via its path', () => {
      const out = fuse({
        files: [{ filePath: '/src/beacon/x.ts', score: 0.5, snippet: 'x' }],
        ranking: ranking({
          minScore: 0,
          anchors: { tags: ['beacon'], boostPerTag: 0.08, boostTitle: 0.05 },
        }),
      });
      expect(out[0].score).toBeCloseTo(0.55);
    });

    it('is a no-op when no anchors are configured', () => {
      const out = fuse({
        wiki: [wiki({ tags: ['anything'], score: 0.5 })],
        ranking: ranking({ minScore: 0 }),
      });
      expect(out[0].score).toBeCloseTo(0.5);
    });
  });

  it('sorts descending and slices to topK', () => {
    const out = fuse({
      wiki: [
        wiki({ pageId: 'a', score: 0.9 }),
        wiki({ pageId: 'b', score: 0.7 }),
        wiki({ pageId: 'c', score: 0.8 }),
      ],
      ranking: ranking({ topK: 2, minScore: 0 }),
    });
    expect(out.map(e => (e.kind === 'wiki' ? e.pageId : e.filePath))).toEqual([
      'a',
      'c',
    ]);
  });

  it('truncates a long pitch to maxPitchChars', () => {
    const out = fuse({
      wiki: [wiki({ score: 0.6, pitch: 'x'.repeat(500) })],
      ranking: ranking({ minScore: 0 }),
    });
    const entry = out[0];
    if (entry.kind !== 'wiki') throw new Error('expected wiki entry');
    expect(entry.pitch.length).toBe(MAX_PITCH + 1);
    expect(entry.pitch.endsWith('…')).toBe(true);
  });

  it('collapses whitespace in a pitch', () => {
    const out = fuse({
      wiki: [wiki({ score: 0.6, pitch: 'a\n\n  b   c' })],
      ranking: ranking({ minScore: 0 }),
    });
    const entry = out[0];
    if (entry.kind !== 'wiki') throw new Error('expected wiki entry');
    expect(entry.pitch).toBe('a b c');
  });

  it('falls back to the matched chunk when a page has no pitch', () => {
    const out = fuse({
      wiki: [wiki({ score: 0.6, matchedChunk: 'the matched text' })],
      ranking: ranking({ minScore: 0 }),
    });
    const entry = out[0];
    if (entry.kind !== 'wiki') throw new Error('expected wiki entry');
    expect(entry.pitch).toBe('the matched text');
  });

  it('returns [] for empty input', () => {
    expect(fuse({})).toEqual([]);
  });
});
