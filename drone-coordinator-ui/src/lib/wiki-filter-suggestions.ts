import type { WikiPageMeta } from '@/lib/types';

/**
 * Compute completions for the token after the last comma in a comma-separated
 * input (e.g. typing "ops, dep" suggests against "dep"). Pure — no React.
 *
 * @param query The full input value.
 * @param candidates Possible tokens to suggest.
 * @param limit Maximum number of suggestions to return.
 * @returns `tokenStart` is the index at which the caller should splice in a
 *   chosen suggestion (replacing from there to the end of the string). It
 *   points past any whitespace after the last comma, so the separator the user
 *   typed is preserved by `query.slice(0, tokenStart) + suggestion`.
 */
export function computeCommaTokenSuggestions(
  query: string,
  candidates: string[],
  limit = 8
): { tokenStart: number; suggestions: string[] } {
  const lastComma = query.lastIndexOf(',');
  let tokenStart = lastComma + 1;
  while (tokenStart < query.length && /\s/.test(query[tokenStart])) {
    tokenStart++;
  }
  const token = query.slice(tokenStart).trim();
  const lowered = token.toLowerCase();

  const seen = new Set<string>();
  const suggestions: string[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const candidateLower = candidate.toLowerCase();
    if (candidateLower.startsWith(lowered) && candidateLower !== lowered) {
      suggestions.push(candidate);
    }
  }

  suggestions.sort((a, b) => a.localeCompare(b));
  return { tokenStart, suggestions: suggestions.slice(0, limit) };
}

/** All distinct tags across the pages, sorted. */
export function distinctTags(pages: WikiPageMeta[]): string[] {
  const tags = new Set<string>();
  for (const page of pages) {
    for (const tag of page.tags) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/** All distinct source session IDs across the pages, sorted. */
export function distinctSources(pages: WikiPageMeta[]): string[] {
  const sources = new Set<string>();
  for (const page of pages) {
    for (const source of page.sources) sources.add(source);
  }
  return [...sources].sort((a, b) => a.localeCompare(b));
}
