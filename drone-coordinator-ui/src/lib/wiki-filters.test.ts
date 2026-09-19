import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WIKI_FILTERS,
  RECENT_WINDOW_DAYS,
  applyWikiFilters,
  countActiveFilters,
  filtersAreDefault,
  parseWikiFilters,
  type WikiFilters,
} from './wiki-filters';
import type { WikiPageMeta } from './types';

const NOW = Date.parse('2026-09-18T12:00:00.000Z');

function page(overrides: Partial<WikiPageMeta> = {}): WikiPageMeta {
  return {
    id: 'p',
    title: 'P',
    scope: 'coordinator',
    tags: [],
    sources: [],
    wordCount: 10,
    linkCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function filters(overrides: Partial<WikiFilters> = {}): WikiFilters {
  return { ...DEFAULT_WIKI_FILTERS, ...overrides };
}

describe('parseWikiFilters', () => {
  it('defaults when params are absent', () => {
    expect(parseWikiFilters(new URLSearchParams())).toEqual(
      DEFAULT_WIKI_FILTERS
    );
  });

  it('parses comma lists, trimming and de-duplicating', () => {
    const parsed = parseWikiFilters(
      new URLSearchParams({ tags: ' ops , design ,ops', srcs: 's1' })
    );
    expect(parsed.tags).toEqual(['ops', 'design']);
    expect(parsed.sources).toEqual(['s1']);
  });

  it('reads the date field, range, and state flags', () => {
    const parsed = parseWikiFilters(
      new URLSearchParams({
        dfield: 'created',
        dfrom: '2026-01-01',
        dto: '2026-02-01',
        links: '1',
        hasSources: '1',
        recent: '1',
      })
    );
    expect(parsed.dateField).toBe('created');
    expect(parsed.dateFrom).toBe('2026-01-01');
    expect(parsed.dateTo).toBe('2026-02-01');
    expect(parsed.hasLinks).toBe(true);
    expect(parsed.hasSources).toBe(true);
    expect(parsed.recentlyCreated).toBe(true);
  });

  it('falls back to the updated field for an unknown dfield value', () => {
    expect(
      parseWikiFilters(new URLSearchParams({ dfield: 'nope' })).dateField
    ).toBe('updated');
  });
});

describe('applyWikiFilters', () => {
  it('a default filter set matches every page', () => {
    expect(applyWikiFilters(page(), DEFAULT_WIKI_FILTERS, NOW)).toBe(true);
  });

  it('tags use OR semantics', () => {
    const p = page({ tags: ['design'] });
    expect(applyWikiFilters(p, filters({ tags: ['ops', 'design'] }), NOW)).toBe(
      true
    );
    expect(applyWikiFilters(p, filters({ tags: ['ops', 'misc'] }), NOW)).toBe(
      false
    );
  });

  it('sources use contains-match over the comma list', () => {
    const p = page({ sources: ['session-abc123'] });
    expect(applyWikiFilters(p, filters({ sources: ['abc'] }), NOW)).toBe(true);
    expect(applyWikiFilters(p, filters({ sources: ['xyz'] }), NOW)).toBe(false);
  });

  it('date range is inclusive and honours the active field', () => {
    const p = page({
      createdAt: '2026-01-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    });
    expect(
      applyWikiFilters(
        p,
        filters({ dateFrom: '2026-09-15', dateTo: '2026-09-15' }),
        NOW
      )
    ).toBe(true);
    expect(
      applyWikiFilters(
        p,
        filters({ dateField: 'created', dateFrom: '2026-09-01' }),
        NOW
      )
    ).toBe(false);
  });

  it('has links and has sources read the derived/length fields', () => {
    expect(
      applyWikiFilters(page({ linkCount: 0 }), filters({ hasLinks: true }), NOW)
    ).toBe(false);
    expect(
      applyWikiFilters(page({ linkCount: 2 }), filters({ hasLinks: true }), NOW)
    ).toBe(true);
    expect(
      applyWikiFilters(
        page({ sources: [] }),
        filters({ hasSources: true }),
        NOW
      )
    ).toBe(false);
    expect(
      applyWikiFilters(
        page({ sources: ['s1'] }),
        filters({ hasSources: true }),
        NOW
      )
    ).toBe(true);
  });

  it('recently created uses a fixed 7-day window', () => {
    expect(RECENT_WINDOW_DAYS).toBe(7);
    const sixDaysAgo = new Date(NOW - 6 * 24 * 60 * 60 * 1000).toISOString();
    const eightDaysAgo = new Date(NOW - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      applyWikiFilters(
        page({ createdAt: sixDaysAgo }),
        filters({ recentlyCreated: true }),
        NOW
      )
    ).toBe(true);
    expect(
      applyWikiFilters(
        page({ createdAt: eightDaysAgo }),
        filters({ recentlyCreated: true }),
        NOW
      )
    ).toBe(false);
  });

  it('combines filters with AND', () => {
    const p = page({ tags: ['ops'], sources: ['s1'], linkCount: 1 });
    const combined = filters({ tags: ['ops'], hasLinks: true });
    expect(applyWikiFilters(p, combined, NOW)).toBe(true);
    expect(
      applyWikiFilters(
        page({ tags: ['ops'], sources: [] }),
        filters({ tags: ['ops'], hasSources: true }),
        NOW
      )
    ).toBe(false);
  });
});

describe('countActiveFilters / filtersAreDefault', () => {
  it('counts each active group once', () => {
    expect(countActiveFilters(DEFAULT_WIKI_FILTERS)).toBe(0);
    expect(
      countActiveFilters(
        filters({ tags: ['a', 'b'], hasLinks: true, dateFrom: 'x' })
      )
    ).toBe(3);
  });

  it('reports default state only when nothing is active', () => {
    expect(filtersAreDefault(DEFAULT_WIKI_FILTERS)).toBe(true);
    expect(filtersAreDefault(filters({ hasSources: true }))).toBe(false);
  });
});
