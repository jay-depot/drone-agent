import { describe, expect, it } from 'vitest';
import {
  dedupeAndCombineChunks,
  type ScoredChunk,
} from '../src/search-searcher.js';

function chunk(
  filePath: string,
  chunkIndex: number,
  text: string,
  score: number
): ScoredChunk {
  return { filePath, chunkIndex, text, score };
}

describe('dedupeAndCombineChunks', () => {
  it('dedupes by file, keeping the best chunk score', () => {
    const scored = [
      chunk('a.ts', 0, 'chunk a0', 0.5),
      chunk('a.ts', 1, 'chunk a1', 0.9),
      chunk('b.ts', 0, 'chunk b0', 0.7),
    ];
    const results = dedupeAndCombineChunks(scored, { maxResults: 10 });
    expect(results).toHaveLength(2);
    // a.ts ranks first with the best chunk's score.
    expect(results[0].filePath).toBe('a.ts');
    expect(results[0].score).toBe(0.9);
    expect(results[0].chunkIndex).toBe(1);
    expect(results[1].filePath).toBe('b.ts');
  });

  it('combines consecutive chunks without a gap marker', () => {
    const scored = [
      chunk('a.ts', 0, 'first', 0.5),
      chunk('a.ts', 1, 'second', 0.6),
    ];
    const results = dedupeAndCombineChunks(scored, { maxResults: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('first\n\nsecond');
    expect(results[0].text).not.toContain('[...]');
  });

  it('inserts a gap marker between non-consecutive chunks', () => {
    const scored = [
      chunk('a.ts', 0, 'first', 0.5),
      chunk('a.ts', 2, 'third', 0.6),
    ];
    const results = dedupeAndCombineChunks(scored, { maxResults: 10 });
    expect(results).toHaveLength(1);
    expect(results[0].text).toBe('first\n\n[...]\n\nthird');
  });

  it('caps the combined text length', () => {
    const scored = [
      chunk('a.ts', 0, 'x'.repeat(100), 0.5),
      chunk('a.ts', 1, 'y'.repeat(100), 0.6),
    ];
    const results = dedupeAndCombineChunks(scored, {
      maxResults: 10,
      maxCombinedChars: 150,
    });
    expect(results[0].text.length).toBeLessThanOrEqual(150 + 2); // + '\n…'
    expect(results[0].text.endsWith('\n…')).toBe(true);
  });

  it('respects maxResults', () => {
    const scored = [
      chunk('a.ts', 0, 'a', 0.9),
      chunk('b.ts', 0, 'b', 0.8),
      chunk('c.ts', 0, 'c', 0.7),
    ];
    const results = dedupeAndCombineChunks(scored, { maxResults: 2 });
    expect(results).toHaveLength(2);
    expect(results.map(r => r.filePath)).toEqual(['a.ts', 'b.ts']);
  });

  it('sorts results by score descending', () => {
    const scored = [
      chunk('a.ts', 0, 'a', 0.5),
      chunk('b.ts', 0, 'b', 0.9),
      chunk('c.ts', 0, 'c', 0.7),
    ];
    const results = dedupeAndCombineChunks(scored, { maxResults: 10 });
    expect(results.map(r => r.filePath)).toEqual(['b.ts', 'c.ts', 'a.ts']);
  });
});
