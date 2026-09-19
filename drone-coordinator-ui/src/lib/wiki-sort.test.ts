import { describe, expect, it } from 'vitest';
import { parseWikiSort, sortWikiPages } from './wiki-sort';
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

const pages: WikiPageMeta[] = [
  page({ id: 'b', title: 'Beta', wordCount: 300, sources: ['s1'] }),
  page({
    id: 'a',
    title: 'alpha',
    wordCount: 100,
    sources: ['s1', 's2'],
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
  }),
  page({
    id: 'c',
    title: 'Gamma',
    wordCount: 200,
    sources: [],
    createdAt: '2026-02-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  }),
];

describe('parseWikiSort', () => {
  it('returns a null key when no sort param is present', () => {
    expect(parseWikiSort(new URLSearchParams())).toEqual({
      key: null,
      dir: 'asc',
    });
  });

  it('reads a valid key and direction', () => {
    expect(
      parseWikiSort(new URLSearchParams({ sort: 'words', dir: 'desc' }))
    ).toEqual({ key: 'words', dir: 'desc' });
  });

  it('ignores an unknown sort key', () => {
    expect(
      parseWikiSort(new URLSearchParams({ sort: 'bogus' })).key
    ).toBeNull();
  });
});

describe('sortWikiPages', () => {
  const ids = (list: WikiPageMeta[]) => list.map(p => p.id);

  it('sorts by title asc and desc (case-insensitive locale)', () => {
    expect(ids(sortWikiPages(pages, 'title', 'asc'))).toEqual(['a', 'b', 'c']);
    expect(ids(sortWikiPages(pages, 'title', 'desc'))).toEqual(['c', 'b', 'a']);
  });

  it('sorts by created and updated ISO timestamps', () => {
    expect(ids(sortWikiPages(pages, 'created', 'asc'))).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(ids(sortWikiPages(pages, 'updated', 'desc'))).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('sorts by word count numerically', () => {
    expect(ids(sortWikiPages(pages, 'words', 'asc'))).toEqual(['a', 'c', 'b']);
  });

  it('sorts by source count numerically', () => {
    expect(ids(sortWikiPages(pages, 'sources', 'desc'))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('never mutates the input array', () => {
    const original = [...pages];
    sortWikiPages(pages, 'words', 'desc');
    expect(ids(pages)).toEqual(ids(original));
  });
});
