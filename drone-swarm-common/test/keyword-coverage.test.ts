import { describe, expect, it } from 'vitest';

import {
  contentTerms,
  keywordCoverage,
} from '../src/keyword-coverage.js';

describe('contentTerms', () => {
  it('lowercases and drops stopwords', () => {
    expect(contentTerms('How do I fix the reindex bug')).toEqual([
      'fix',
      'reindex',
      'bug',
    ]);
  });

  it('drops tokens of two characters or fewer', () => {
    expect(contentTerms('is it ok to go')).toEqual([]);
  });

  it('collapses duplicates keeping first-occurrence order', () => {
    expect(contentTerms('reindex chunk reindex chunk')).toEqual([
      'reindex',
      'chunk',
    ]);
  });

  it('keeps negations, which are load-bearing in debugging queries', () => {
    expect(contentTerms('reindex not working')).toContain('not');
  });

  it('keeps numeric tokens of three or more characters', () => {
    expect(contentTerms('ADR 259 nomic-embed-text v1.5')).toEqual([
      'adr',
      '259',
      'nomic',
      'embed',
      'text',
    ]);
  });

  it('drops short version fragments by design (trigram covers those)', () => {
    // "v1.5" tokenizes to "v1" + "5"; both are <= 2 chars and are dropped.
    // Navigational lookup for version tags is the trigram index's job.
    expect(contentTerms('v1.5')).toEqual([]);
  });

  it('returns an empty list for an empty query', () => {
    expect(contentTerms('')).toEqual([]);
  });
});

describe('keywordCoverage', () => {
  const terms = contentTerms('wiki indexer duplicate chunks');

  it('returns 0 when nothing matches', () => {
    expect(keywordCoverage(terms, 'unrelated page about sourdough')).toBe(0);
  });

  it('returns 0 for empty inputs', () => {
    expect(keywordCoverage([], 'anything')).toBe(0);
    expect(keywordCoverage(terms, '')).toBe(0);
  });

  it('gives half credit for a single match (saturation at 2)', () => {
    expect(keywordCoverage(terms, 'the indexer was broken')).toBeCloseTo(0.5);
  });

  it('gives full credit at two matches', () => {
    expect(keywordCoverage(terms, 'the indexer duplicated rows')).toBe(1);
  });

  it('saturates at 1 rather than exceeding it', () => {
    expect(
      keywordCoverage(terms, 'wiki indexer duplicate chunks everywhere')
    ).toBe(1);
  });

  it('matches inflections via word-prefix, not exact equality', () => {
    // Unstemmed query term "reindex" must find "reindexing".
    const t = contentTerms('reindex');
    expect(keywordCoverage(t, 'reindexing the corpus')).toBeCloseTo(0.5);
  });

  it('requires a word boundary so short terms do not match inside words', () => {
    const t = contentTerms('index');
    // "index" must not match inside "reindexed".
    expect(keywordCoverage(t, 'reindexed corpus')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(keywordCoverage(contentTerms('Indexer'), 'THE INDEXER')).toBeCloseTo(
      0.5
    );
  });

  it('treats regex metacharacters as literals', () => {
    const t = contentTerms('v1.5');
    expect(() => keywordCoverage(t, 'nomic v1.5 model')).not.toThrow();
  });
});
