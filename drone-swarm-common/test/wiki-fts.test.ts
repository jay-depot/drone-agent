import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  countWikiFtsRows,
  deleteWikiFtsRows,
  replaceWikiFtsRows,
  searchWikiFts,
} from '../src/wiki-fts.js';

/**
 * The DDL mirrors `drone-beacon/src/db/init.ts`. It lives here so this package's
 * tests stay self-contained; the beacon owns the real schema.
 */
const DDL = `
  CREATE VIRTUAL TABLE wiki_fts USING fts5(
    page_id UNINDEXED, origin UNINDEXED,
    title, tags, pitch, body,
    tokenize = 'porter'
  );
  CREATE VIRTUAL TABLE wiki_fts_trigram USING fts5(
    page_id UNINDEXED, origin UNINDEXED,
    title, tags, body,
    tokenize = 'trigram'
  );
`;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(DDL);
  return db;
}

function page(over: Partial<Parameters<typeof replaceWikiFtsRows>[1]> = {}) {
  return {
    pageId: 'reindex-bug',
    origin: 'beacon',
    title: 'Wiki reindex duplicated chunks on hash mismatch',
    tags: 'drone-beacon wiki reindex',
    pitch: 'The changed-content path inserted without deleting.',
    body: 'The indexer reindexes duplicated chunks every time.',
    ...over,
  };
}

describe('wiki-fts', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    replaceWikiFtsRows(() => db, page());
  });

  describe('stemmed (porter) mode', () => {
    it('matches an inflected query against the stemmed form', () => {
      // Body says "reindexes"; query says "reindex".
      const hits = searchWikiFts(() => db, 'reindex', { mode: 'stemmed' });
      expect(hits.map(h => h.pageId)).toContain('reindex-bug');
    });

    it('matches terms from the title', () => {
      const hits = searchWikiFts(() => db, 'duplicated', { mode: 'stemmed' });
      expect(hits.map(h => h.pageId)).toContain('reindex-bug');
    });

    it('ORs multiple terms so any one is enough', () => {
      const hits = searchWikiFts(() => db, 'nonexistentterm reindex', {
        mode: 'stemmed',
      });
      expect(hits.map(h => h.pageId)).toContain('reindex-bug');
    });

    it('returns nothing when no term matches', () => {
      expect(
        searchWikiFts(() => db, 'sourdough fermentation', { mode: 'stemmed' })
      ).toEqual([]);
    });

    it('reports scores with higher = better (negated bm25)', () => {
      const [hit] = searchWikiFts(() => db, 'reindex', { mode: 'stemmed' });
      expect(hit.score).toBeGreaterThan(0);
    });

    it('ranks a title match above a body-only match', () => {
      replaceWikiFtsRows(() => db, {
        pageId: 'body-only',
        origin: 'beacon',
        title: 'Unrelated page',
        tags: '',
        body: 'This body talks about reindex too.',
      });
      const hits = searchWikiFts(() => db, 'reindex', { mode: 'stemmed' });
      const rankOf = (id: string) => hits.findIndex(h => h.pageId === id);
      expect(rankOf('reindex-bug')).toBeLessThan(rankOf('body-only'));
    });
  });

  describe('trigram mode', () => {
    it('finds an exact substring inside a token', () => {
      const hits = searchWikiFts(() => db, 'eindex', { mode: 'trigram' });
      expect(hits.map(h => h.pageId)).toContain('reindex-bug');
    });

    it('finds a hash-like token that stemming would destroy', () => {
      replaceWikiFtsRows(() => db, {
        pageId: 'commit-page',
        origin: 'beacon',
        title: 'Fix commit 5e313af9',
        tags: '',
        body: 'See 5e313af9 for details.',
      });
      const hits = searchWikiFts(() => db, '5e313af9', { mode: 'trigram' });
      expect(hits.map(h => h.pageId)).toContain('commit-page');
    });

    it('ignores queries shorter than the trigram minimum', () => {
      expect(searchWikiFts(() => db, 'ab', { mode: 'trigram' })).toEqual([]);
    });

    it('treats FTS5 operator characters as literals', () => {
      expect(() =>
        searchWikiFts(() => db, 'reindex -hash * (x)', { mode: 'trigram' })
      ).not.toThrow();
    });
  });

  describe('operator-safety in stemmed mode', () => {
    it('does not throw on quotes, parens, asterisks, or colons', () => {
      for (const q of ['"unbalanced', 'a(b)c', 'wild*card', 'tag:value']) {
        expect(() =>
          searchWikiFts(() => db, q, { mode: 'stemmed' })
        ).not.toThrow();
      }
    });

    it('returns [] for a query with no usable tokens', () => {
      expect(searchWikiFts(() => db, '   ', { mode: 'stemmed' })).toEqual([]);
      expect(searchWikiFts(() => db, '!!??', { mode: 'stemmed' })).toEqual([]);
    });
  });

  describe('replace / delete semantics', () => {
    it('does not duplicate rows when a page is replaced', () => {
      replaceWikiFtsRows(() => db, page({ body: 'rewritten body text' }));
      expect(countWikiFtsRows(() => db)).toBe(1);
      const hits = searchWikiFts(() => db, 'reindex', { mode: 'stemmed' });
      expect(hits.filter(h => h.pageId === 'reindex-bug')).toHaveLength(1);
    });

    it('drops the old body when a page is replaced', () => {
      replaceWikiFtsRows(
        () => db,
        page({ body: 'completely different words here' })
      );
      const hits = searchWikiFts(() => db, 'duplicated', { mode: 'stemmed' });
      // "duplicated" still appears in the title, so scope the assertion to the body-only token.
      const bodyHits = searchWikiFts(() => db, 'indexer', { mode: 'stemmed' });
      expect(bodyHits.map(h => h.pageId)).not.toContain('reindex-bug');
      expect(hits.map(h => h.pageId)).toContain('reindex-bug');
    });

    it('deletes from both indexes', () => {
      deleteWikiFtsRows(() => db, 'reindex-bug', 'beacon');
      expect(countWikiFtsRows(() => db)).toBe(0);
      expect(searchWikiFts(() => db, 'reindex', { mode: 'trigram' })).toEqual(
        []
      );
    });

    it('is a no-op when deleting an unknown page', () => {
      expect(() =>
        deleteWikiFtsRows(() => db, 'never-indexed', 'beacon')
      ).not.toThrow();
    });

    it('keeps origins separate', () => {
      replaceWikiFtsRows(() => db, page({ origin: 'coordinator' }));
      const hits = searchWikiFts(() => db, 'reindex', {
        mode: 'stemmed',
        origin: 'coordinator',
      });
      expect(hits.every(h => h.origin === 'coordinator')).toBe(true);
    });
  });

  describe('limits', () => {
    it('honours the limit', () => {
      for (let i = 0; i < 5; i++) {
        replaceWikiFtsRows(() => db, page({ pageId: `p${i}` }));
      }
      expect(
        searchWikiFts(() => db, 'reindex', { mode: 'stemmed', limit: 2 })
      ).toHaveLength(2);
    });
  });
});
