import { getDatabase } from './init.js';

/**
 * Increment a page's agent read count, creating the row (count = 1) when it
 * does not exist. Atomic: the upsert and the read-back run in one transaction.
 */
export function incrementWikiReadCount(pageId: string): number {
  return getDatabase().transaction((id: string) => {
    getDatabase()
      .prepare(
        `INSERT INTO wiki_page_metadata (page_id, read_count, last_read_at)
         VALUES (?, 1, ?)
         ON CONFLICT(page_id) DO UPDATE SET
           read_count = read_count + 1,
           last_read_at = excluded.last_read_at`
      )
      .run(id, Date.now());
    const row = getDatabase()
      .prepare('SELECT read_count FROM wiki_page_metadata WHERE page_id = ?')
      .get(id) as { read_count: number };
    return row.read_count;
  })(pageId);
}

export function getWikiReadCount(pageId: string): number {
  const row = getDatabase()
    .prepare('SELECT read_count FROM wiki_page_metadata WHERE page_id = ?')
    .get(pageId) as { read_count: number } | undefined;
  return row?.read_count ?? 0;
}

/** All read counts as pageId → count, for merging onto page lists. */
export function getWikiReadCounts(): Map<string, number> {
  const rows = getDatabase()
    .prepare('SELECT page_id, read_count FROM wiki_page_metadata')
    .all() as Array<{ page_id: string; read_count: number }>;
  return new Map(rows.map(r => [r.page_id, r.read_count]));
}

export function deleteWikiPageMetadata(pageId: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM wiki_page_metadata WHERE page_id = ?')
    .run(pageId);
  return result.changes > 0;
}
