import type { WikiPageMeta } from '@/lib/types';

/** Window (in days) for the "Recently created" page-state filter. */
export const RECENT_WINDOW_DAYS = 7;

/**
 * Active wiki-list filters. Empty arrays / false booleans / null dates mean
 * "inactive", so a default filter object matches every page.
 */
export type WikiFilters = {
  tags: string[];
  sources: string[];
  dateField: 'created' | 'updated';
  dateFrom: string | null;
  dateTo: string | null;
  hasLinks: boolean;
  hasSources: boolean;
  recentlyCreated: boolean;
};

export const DEFAULT_WIKI_FILTERS: WikiFilters = {
  tags: [],
  sources: [],
  dateField: 'updated',
  dateFrom: null,
  dateTo: null,
  hasLinks: false,
  hasSources: false,
  recentlyCreated: false,
};

/** Split a comma-separated param into trimmed, de-duplicated tokens. */
function parseCommaList(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

export function parseWikiFilters(params: URLSearchParams): WikiFilters {
  return {
    tags: parseCommaList(params.get('tags')),
    sources: parseCommaList(params.get('srcs')),
    dateField: params.get('dfield') === 'created' ? 'created' : 'updated',
    dateFrom: params.get('dfrom'),
    dateTo: params.get('dto'),
    hasLinks: params.get('links') === '1',
    hasSources: params.get('hasSources') === '1',
    recentlyCreated: params.get('recent') === '1',
  };
}

function matchesTags(page: WikiPageMeta, tags: string[]): boolean {
  if (tags.length === 0) return true;
  return tags.some(tag => page.tags.includes(tag));
}

function matchesSources(page: WikiPageMeta, sources: string[]): boolean {
  if (sources.length === 0) return true;
  return sources.some(needle =>
    page.sources.some(source => source.includes(needle))
  );
}

/**
 * Compare a page's ISO timestamp against a `YYYY-MM-DD` range. The range is
 * inclusive; an absent bound is unbounded. Compare on the date prefix only, so
 * a `dateTo` equal to a page's day still includes that page.
 */
function matchesDateRange(page: WikiPageMeta, filters: WikiFilters): boolean {
  if (!filters.dateFrom && !filters.dateTo) return true;
  const value =
    filters.dateField === 'created' ? page.createdAt : page.updatedAt;
  const day = value.slice(0, 10);
  if (filters.dateFrom && day < filters.dateFrom) return false;
  if (filters.dateTo && day > filters.dateTo) return false;
  return true;
}

function matchesRecentlyCreated(page: WikiPageMeta, now: number): boolean {
  const created = Date.parse(page.createdAt);
  if (Number.isNaN(created)) return false;
  const cutoff = now - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return created >= cutoff;
}

/**
 * True when a page passes every active filter. `now` is injectable for tests.
 */
export function applyWikiFilters(
  page: WikiPageMeta,
  filters: WikiFilters,
  now: number = Date.now()
): boolean {
  if (!matchesTags(page, filters.tags)) return false;
  if (!matchesSources(page, filters.sources)) return false;
  if (!matchesDateRange(page, filters)) return false;
  if (filters.hasLinks && page.linkCount <= 0) return false;
  if (filters.hasSources && page.sources.length === 0) return false;
  if (filters.recentlyCreated && !matchesRecentlyCreated(page, now)) {
    return false;
  }
  return true;
}

/** Number of active filter groups, for the "N filters" badge. */
export function countActiveFilters(filters: WikiFilters): number {
  let count = 0;
  if (filters.tags.length > 0) count++;
  if (filters.sources.length > 0) count++;
  if (filters.dateFrom || filters.dateTo) count++;
  if (filters.hasLinks) count++;
  if (filters.hasSources) count++;
  if (filters.recentlyCreated) count++;
  return count;
}

/** True when no filter narrows the list (i.e. the default state). */
export function filtersAreDefault(filters: WikiFilters): boolean {
  return countActiveFilters(filters) === 0;
}
