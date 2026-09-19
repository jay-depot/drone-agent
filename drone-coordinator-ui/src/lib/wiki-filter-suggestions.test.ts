import { describe, expect, it } from 'vitest';
import {
  computeCommaTokenSuggestions,
  distinctSources,
  distinctTags,
} from './wiki-filter-suggestions';
import type { WikiPageMeta } from './types';

function page(overrides: Partial<WikiPageMeta> = {}): WikiPageMeta {
  return {
    id: 'p',
    title: 'P',
    scope: 'coordinator',
    tags: [],
    sources: [],
    wordCount: 0,
    linkCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('computeCommaTokenSuggestions', () => {
  const candidates = ['architecture', 'archived', 'design', 'ops'];

  it('suggests against the token after the last comma', () => {
    const { tokenStart, suggestions } = computeCommaTokenSuggestions(
      'ops, des',
      candidates
    );
    expect(tokenStart).toBe(5);
    expect(suggestions).toEqual(['design']);
  });

  it('suggests from the start when there is no comma', () => {
    const { tokenStart, suggestions } = computeCommaTokenSuggestions(
      'arch',
      candidates
    );
    expect(tokenStart).toBe(0);
    expect(suggestions).toEqual(['architecture', 'archived']);
  });

  it('is case-insensitive but preserves candidate casing', () => {
    const { suggestions } = computeCommaTokenSuggestions('DES', ['Design']);
    expect(suggestions).toEqual(['Design']);
  });

  it('drops an exact match for the current token', () => {
    const { suggestions } = computeCommaTokenSuggestions('design', candidates);
    expect(suggestions).not.toContain('design');
  });

  it('caps the suggestion count', () => {
    const many = Array.from({ length: 20 }, (_, i) => `suggestion-${i}`);
    const { suggestions } = computeCommaTokenSuggestions('suggest', many, 5);
    expect(suggestions).toHaveLength(5);
  });
});

describe('distinctTags / distinctSources', () => {
  it('unions and sorts tag values', () => {
    const pages = [
      page({ tags: ['ops', 'design'] }),
      page({ tags: ['ops'] }),
      page({ tags: ['personal'] }),
    ];
    expect(distinctTags(pages)).toEqual(['design', 'ops', 'personal']);
  });

  it('unions and sorts source values', () => {
    const pages = [page({ sources: ['s2'] }), page({ sources: ['s1', 's2'] })];
    expect(distinctSources(pages)).toEqual(['s1', 's2']);
  });
});
