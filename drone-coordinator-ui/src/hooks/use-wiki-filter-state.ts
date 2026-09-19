import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DEFAULT_WIKI_FILTERS,
  parseWikiFilters,
  type WikiFilters,
} from '@/lib/wiki-filters';
import { parseWikiSort, type SortDir, type WikiSortKey } from '@/lib/wiki-sort';

const FILTER_PARAMS = [
  'tags',
  'srcs',
  'dfield',
  'dfrom',
  'dto',
  'links',
  'hasSources',
  'recent',
] as const;

/** Write filters to params, omitting every value that equals its default. */
function serializeFilters(params: URLSearchParams, filters: WikiFilters): void {
  for (const key of FILTER_PARAMS) params.delete(key);
  if (filters.tags.length > 0) params.set('tags', filters.tags.join(','));
  if (filters.sources.length > 0) params.set('srcs', filters.sources.join(','));
  if (filters.dateField === 'created') params.set('dfield', 'created');
  if (filters.dateFrom) params.set('dfrom', filters.dateFrom);
  if (filters.dateTo) params.set('dto', filters.dateTo);
  if (filters.hasLinks) params.set('links', '1');
  if (filters.hasSources) params.set('hasSources', '1');
  if (filters.recentlyCreated) params.set('recent', '1');
}

/**
 * URL-backed filter + sort state for the wiki list. Mirrors
 * `usePaginationOffset`: state lives in query params so a filtered view is
 * shareable and Back/Forward work. Any filter or sort change resets `offset`.
 * Unrelated params (`view`, `node`, `tagnodes`) are preserved.
 */
export function useWikiFilterState(): {
  filters: WikiFilters;
  sort: { key: WikiSortKey | null; dir: SortDir };
  setFilters: (next: WikiFilters) => void;
  setSort: (key: WikiSortKey | null) => void;
  clearFilters: () => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = parseWikiFilters(searchParams);
  const sort = parseWikiSort(searchParams);

  const commit = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams);
      mutate(params);
      params.delete('offset');
      setSearchParams(params);
    },
    [searchParams, setSearchParams]
  );

  const setFilters = useCallback(
    (next: WikiFilters) => commit(params => serializeFilters(params, next)),
    [commit]
  );

  const clearFilters = useCallback(
    () => commit(params => serializeFilters(params, DEFAULT_WIKI_FILTERS)),
    [commit]
  );

  const setSort = useCallback(
    (key: WikiSortKey | null) => {
      commit(params => {
        if (key === null) {
          params.delete('sort');
          params.delete('dir');
          return;
        }
        const current = parseWikiSort(params);
        const dir: SortDir =
          current.key === key
            ? current.dir === 'asc'
              ? 'desc'
              : 'asc'
            : key === 'updated'
              ? 'desc'
              : 'asc';
        params.set('sort', key);
        params.set('dir', dir);
      });
    },
    [commit]
  );

  return { filters, sort, setFilters, setSort, clearFilters };
}
