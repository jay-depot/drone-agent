/**
 * Keyword coverage scoring for the wiki keyword index.
 *
 * Coverage answers "how much of the user's query appears in this page?",
 * independent of any embedding. It is deliberately bounded to [0, 1] so it can
 * be added to a cosine similarity as a bonus without rescaling either side.
 *
 * Negations ("not", "no", "never") are intentionally NOT stopwords: in a
 * debugging query they carry meaning.
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'my',
  'of',
  'on',
  'or',
  'our',
  'should',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'us',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/** Query terms matching this many content terms earn full coverage credit. */
const SATURATION_TERMS = 2;

/**
 * Extract the content terms of a query: lowercased alphanumeric tokens longer
 * than two characters, with stopwords removed and duplicates collapsed.
 *
 * Order is preserved (first occurrence wins) so callers can prefer earlier
 * terms when truncating.
 */
export function contentTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (token.length <= 2 || STOP_WORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fraction of the query's content terms present in `text`, saturating at
 * `SATURATION_TERMS` matches.
 *
 * Matching is word-prefix based so an unstemmed query term still finds its
 * inflections ("reindex" matches "reindexing"). This is an approximation of the
 * porter stemming done inside the FTS index, which handles candidate recall;
 * coverage only decides how much bonus a candidate has earned.
 */
export function keywordCoverage(terms: string[], text: string): number {
  if (terms.length === 0 || text.length === 0) return 0;
  let matched = 0;
  for (const term of terms) {
    if (new RegExp(`\\b${escapeRegExp(term)}`, 'i').test(text)) {
      matched += 1;
    }
  }
  return Math.min(1, matched / SATURATION_TERMS);
}
