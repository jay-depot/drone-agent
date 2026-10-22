/**
 * FTS5 access for the wiki keyword index.
 *
 * Two virtual tables back this, because an FTS5 tokenizer is a table option and
 * tokenizers cannot be mixed per column:
 *
 * - `wiki_fts`         `tokenize='porter'`  — stemming, feeds coverage scoring
 * - `wiki_fts_trigram` `tokenize='trigram'` — substring/navigational lookup
 *
 * The database is injected as a thunk so this package never depends on
 * `better-sqlite3` (see `db-helpers.ts`).
 */

import type { Database } from './db-helpers.js';

export type WikiFtsMode = 'stemmed' | 'trigram';

export type WikiFtsHit = {
  pageId: string;
  origin: string;
  /** Relevance, higher is better. Negated from FTS5 `bm25()` (which is lower-is-better). */
  score: number;
  /** Best-matching excerpt, present only when `withSnippet` was requested. */
  snippet?: string;
};

export type WikiFtsPage = {
  pageId: string;
  origin: string;
  title: string;
  tags: string;
  pitch?: string;
  body: string;
};

const TABLE_FOR_MODE: Record<WikiFtsMode, string> = {
  stemmed: 'wiki_fts',
  trigram: 'wiki_fts_trigram',
};

/** Trigram tokenization only matches runs of at least three characters. */
const TRIGRAM_MIN_CHARS = 3;

/** Tokens of context returned either side of a match by `snippet()`. */
const SNIPPET_TOKENS = 12;

/**
 * Zero-based column index of `body` within each table's column list.
 *
 * `snippet()` takes a column index, and the two tables differ (only the
 * stemmed table has `pitch`), so this cannot be a shared constant.
 */
function bodyColumnIndex(mode: WikiFtsMode): number {
  // wiki_fts:         page_id, origin, title, tags, pitch, body
  // wiki_fts_trigram: page_id, origin, title, tags,        body
  return mode === 'stemmed' ? 5 : 4;
}

/**
 * Build an FTS5 MATCH expression from raw user input.
 *
 * Raw text cannot be passed to MATCH: characters like `"`, `-`, `*`, `(` and
 * `:` are FTS5 operators and produce a parse error. Every token is therefore
 * double-quoted (doubling any embedded quote) and the tokens are OR-ed, which
 * matches the "any term" semantics the coverage scorer uses.
 *
 * Returns `null` when the input has no term worth searching for.
 */
function buildMatchExpression(query: string, mode: WikiFtsMode): string | null {
  if (mode === 'trigram') {
    const trimmed = query.trim();
    if (trimmed.length < TRIGRAM_MIN_CHARS) return null;
    return `"${trimmed.replace(/"/g, '""')}"`;
  }
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const usable = tokens.filter(t => t.length > 0);
  if (usable.length === 0) return null;
  return usable.map(t => `"${t}"`).join(' OR ');
}

/**
 * Search the wiki keyword index.
 *
 * `score` is FTS5's `bm25()` negated so that, like cosine similarity, higher is
 * better. Only the ordering is meaningful — the magnitude is corpus-dependent
 * and must not be compared against a cosine threshold.
 */
export function searchWikiFts(
  db: () => Database,
  query: string,
  opts: {
    mode: WikiFtsMode;
    limit?: number;
    origin?: string;
    /** Include a best-matching excerpt for each hit. */
    withSnippet?: boolean;
  }
): WikiFtsHit[] {
  const table = TABLE_FOR_MODE[opts.mode];
  const match = buildMatchExpression(query, opts.mode);
  if (!match) return [];

  const limit = Math.max(1, opts.limit ?? 50);
  const originClause = opts.origin ? ' AND origin = ?' : '';
  const params: unknown[] = opts.origin ? [match, opts.origin] : [match];

  // Column index of `body` varies by table (the trigram table has no `pitch`),
  // so resolve it instead of hardcoding.
  const snippetSelect = opts.withSnippet
    ? `, snippet(${table}, ${bodyColumnIndex(opts.mode)}, '', '', '…', ${SNIPPET_TOKENS}) AS snippet`
    : '';

  const rows = db()
    .prepare(
      `SELECT page_id AS pageId, origin, bm25(${table}) AS rank${snippetSelect}
         FROM ${table}
        WHERE ${table} MATCH ?${originClause}
        ORDER BY rank
        LIMIT ?`
    )
    .all(...params, limit) as Array<{
    pageId: string;
    origin: string;
    rank: number;
    snippet?: string;
  }>;

  return rows.map(r => ({
    pageId: r.pageId,
    origin: r.origin,
    score: -r.rank,
    ...(opts.withSnippet ? { snippet: r.snippet ?? '' } : {}),
  }));
}

/**
 * Replace all index rows for one page.
 *
 * FTS5 has no upsert, so this deletes then inserts. The delete is a scan of the
 * table filtered on the `UNINDEXED` key columns — O(pages) per call. Acceptable
 * here because it runs only for pages that actually changed during a background
 * sweep, and it avoids the collision risk of a derived rowid.
 */
export function replaceWikiFtsRows(
  db: () => Database,
  page: WikiFtsPage
): void {
  deleteWikiFtsRows(db, page.pageId, page.origin);

  const pitch = page.pitch ?? '';
  db()
    .prepare(
      `INSERT INTO wiki_fts (page_id, origin, title, tags, pitch, body)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(page.pageId, page.origin, page.title, page.tags, pitch, page.body);

  // The trigram table has no `pitch` column: pitch is already part of the page
  // body for substring purposes and trigram only serves navigational lookup.
  db()
    .prepare(
      `INSERT INTO wiki_fts_trigram (page_id, origin, title, tags, body)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(page.pageId, page.origin, page.title, page.tags, page.body);
}

/** Remove a page from both indexes. Safe when the page was never indexed. */
export function deleteWikiFtsRows(
  db: () => Database,
  pageId: string,
  origin: string
): void {
  db()
    .prepare('DELETE FROM wiki_fts WHERE page_id = ? AND origin = ?')
    .run(pageId, origin);
  db()
    .prepare('DELETE FROM wiki_fts_trigram WHERE page_id = ? AND origin = ?')
    .run(pageId, origin);
}

/** Number of distinct pages in the stemmed index; used to detect a needed backfill. */
export function countWikiFtsRows(db: () => Database): number {
  const row = db().prepare('SELECT count(*) AS n FROM wiki_fts').get() as
    { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Whether a page has keyword-index rows.
 *
 * The indexer uses this to repair pages that were embedded before the keyword
 * index existed: the chunk data is already in the database, so the rows can be
 * rebuilt without re-embedding.
 */
export function hasWikiFtsRows(
  db: () => Database,
  pageId: string,
  origin: string
): boolean {
  const row = db()
    .prepare(
      'SELECT 1 AS present FROM wiki_fts WHERE page_id = ? AND origin = ?'
    )
    .get(pageId, origin) as { present: number } | undefined;
  return row !== undefined;
}
