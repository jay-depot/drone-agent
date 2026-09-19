import type { WikiPageMeta } from '@/lib/types';

export type WikiSortKey = 'title' | 'created' | 'updated' | 'words' | 'sources';
export type SortDir = 'asc' | 'desc';

const SORT_KEYS: readonly WikiSortKey[] = [
  'title',
  'created',
  'updated',
  'words',
  'sources',
];

function isSortKey(value: string | null): value is WikiSortKey {
  return value !== null && (SORT_KEYS as readonly string[]).includes(value);
}

/**
 * Read the sort column + direction from the URL. A `null` key means "no column
 * sort" — the caller keeps the server/relevance order untouched.
 */
export function parseWikiSort(params: URLSearchParams): {
  key: WikiSortKey | null;
  dir: SortDir;
} {
  const rawKey = params.get('sort');
  const key = isSortKey(rawKey) ? rawKey : null;
  const dir: SortDir = params.get('dir') === 'desc' ? 'desc' : 'asc';
  return { key, dir };
}

/**
 * Return a new array sorted by the requested column. Never mutates the input.
 * Timestamps compare lexically (ISO-8601 sorts chronologically).
 */
export function sortWikiPages(
  pages: WikiPageMeta[],
  key: WikiSortKey,
  dir: SortDir
): WikiPageMeta[] {
  const factor = dir === 'asc' ? 1 : -1;
  const sorted = [...pages];
  sorted.sort((a, b) => factor * compareByKey(a, b, key));
  return sorted;
}

function compareByKey(
  a: WikiPageMeta,
  b: WikiPageMeta,
  key: WikiSortKey
): number {
  switch (key) {
    case 'title':
      return a.title.localeCompare(b.title);
    case 'created':
      return a.createdAt.localeCompare(b.createdAt);
    case 'updated':
      return a.updatedAt.localeCompare(b.updatedAt);
    case 'words':
      return a.wordCount - b.wordCount;
    case 'sources':
      return a.sources.length - b.sources.length;
  }
}
