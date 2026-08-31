import { createHash } from 'node:crypto';
import type { DroneEmbeddingProvider, DroneWikiPageMeta } from 'drone-core';
import { chunkMarkdown } from 'drone-swarm-common';

import { logger } from './logger.js';
import * as db from './db/index.js';

const CHUNK_TARGET_TOKENS = 480;

export interface WikiPageInput {
  page: DroneWikiPageMeta;
  origin: db.WikiOrigin;
  /** Page body. Optional for beacon pages (read from local storage when omitted); required for coordinator pages. */
  content?: string;
}

export interface WikiIndexResult {
  pagesIndexed: number;
  pagesSkipped: number;
  pagesRemoved: number;
  chunksCreated: number;
}

function pageHash(
  pageId: string,
  origin: string,
  updatedAt: string,
  content: string
): string {
  return createHash('sha256')
    .update(`${pageId}\u0000${origin}\u0000${updatedAt}\u0000${content}`)
    .digest('hex');
}

function emptyResult(): WikiIndexResult {
  return {
    pagesIndexed: 0,
    pagesSkipped: 0,
    pagesRemoved: 0,
    chunksCreated: 0,
  };
}

async function fetchPageContent(page: WikiPageInput): Promise<string> {
  if (page.content !== undefined) {
    return page.content;
  }
  if (page.origin === 'beacon') {
    const { readPage } = await import('drone-swarm-common');
    const local = await readPage(page.page.id);
    if (!local) {
      throw new Error(`wiki page ${page.page.id} disappeared mid-index`);
    }
    return local.content;
  }
  const { proxyWikiToCoordinator } = await import('./routes/context.js');
  const full = (await proxyWikiToCoordinator(
    'GET',
    `/wiki/${encodeURIComponent(page.page.id)}`
  )) as { content?: unknown } | null;
  if (!full || typeof full.content !== 'string') {
    throw new Error(`coordinator content unavailable for ${page.page.id}`);
  }
  return full.content;
}

/**
 * Indexes the merged wiki corpus (beacon-local + coordinator pages) into the
 * dedicated wiki vector store. Deletion-tight: reconciliation always runs
 * against the successfully collected set of pages — a failed coordinator
 * fetch is an error, never an authoritative empty set.
 */
export class WikiIndexer {
  private provider: DroneEmbeddingProvider | null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepIntervalMs: number;

  constructor(
    provider?: DroneEmbeddingProvider,
    sweepIntervalMs: number = 5 * 60 * 1000
  ) {
    this.provider = provider ?? null;
    this.sweepIntervalMs = sweepIntervalMs;
  }

  setProvider(provider: DroneEmbeddingProvider): void {
    this.provider = provider;
  }

  getProvider(): DroneEmbeddingProvider | null {
    return this.provider;
  }

  /**
   * Reconcile the index against an authoritative page set, then (re)index
   * changed pages. Pages missing from `pages` are removed.
   *
   * `reconcileOrigins` scopes the deletion reconcile: only entries whose
   * origin is listed are removed when absent. Defaults to the union of
   * origins present in `pages`. Callers MUST narrow this when a source's
   * page list could not be fetched — a failed fetch is never an
   * authoritative empty set.
   */
  async indexWiki(
    pages: WikiPageInput[],
    reconcileOrigins?: readonly db.WikiOrigin[]
  ): Promise<WikiIndexResult> {
    const provider = this.provider;
    if (!provider) {
      logger.warn('Wiki index: no embedding provider, skipping indexing');
      return emptyResult();
    }

    const result = emptyResult();
    // Default: reconcile BOTH origins. Absence of pages in the authoritative
    // set is authoritative only when the caller says the fetches succeeded.
    const origins = reconcileOrigins ?? (['beacon', 'coordinator'] as const);
    const activeSourceKeys = new Set(
      pages
        .filter(p => origins.includes(p.origin))
        .map(p => sourceKey(p.page.id, p.origin))
    );

    // Set-difference reconcile: anything indexed but absent from the
    // authoritative set is removed (chunks + vec rows + source row).
    for (const source of db.listWikiSources()) {
      if (!origins.includes(source.origin)) continue;
      const key = sourceKeyOf(source);
      if (!activeSourceKeys.has(key)) {
        db.removeWikiSource(source.page_id, source.origin);
        result.pagesRemoved++;
      }
    }

    for (const entry of pages) {
      try {
        const content = await fetchPageContent(entry);
        const hash = pageHash(
          entry.page.id,
          entry.origin,
          entry.page.updatedAt,
          content
        );
        const stored = db
          .listWikiSources()
          .find(s => s.page_id === entry.page.id && s.origin === entry.origin);

        if (stored && stored.hash === hash) {
          result.pagesSkipped++;
          continue;
        }

        const chunkTexts = chunkMarkdown(content, CHUNK_TARGET_TOKENS);
        if (chunkTexts.length === 0) {
          db.removeWikiSource(entry.page.id, entry.origin);
          result.pagesRemoved++;
          continue;
        }

        db.upsertWikiSource(
          entry.page.id,
          entry.origin,
          entry.page.title,
          entry.page.updatedAt,
          hash
        );
        let index = 0;
        for (const text of chunkTexts) {
          const prefixed = `search_document: ${text}`;
          const embedding = await provider.getEmbedding(prefixed);
          db.insertWikiChunk(
            entry.page.id,
            entry.origin,
            index,
            text,
            embedding
          );
          index++;
          result.chunksCreated++;
        }
        result.pagesIndexed++;
      } catch (err) {
        logger.warn(
          `Wiki index: failed to index page ${entry.page.id} (${entry.origin}): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    logger.info(
      `Wiki index: ${result.pagesIndexed} indexed, ${result.pagesSkipped} skipped, ${result.pagesRemoved} removed, ${result.chunksCreated} chunks`
    );
    return result;
  }

  /**
   * Remove every indexed entry (source row + chunks + vec rows).
   */
  clearWiki(): void {
    for (const source of db.listWikiSources()) {
      db.removeWikiSource(source.page_id, source.origin);
    }
  }

  getIndexedPageCount(): number {
    return db.listWikiSources().length;
  }

  // ── Periodic sweep ─────────────────────────────────────────────────

  startPeriodicSweep(runCycle: () => Promise<unknown>): void {
    if (this.sweepTimer) return;
    logger.info(
      `Wiki index: starting periodic sweep every ${this.sweepIntervalMs / 1000}s`
    );
    this.sweepTimer = setInterval(() => {
      runCycle().catch(err => {
        logger.error(err, 'Wiki index: periodic sweep failed');
      });
    }, this.sweepIntervalMs);
  }

  stopPeriodicSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

function sourceKeyOf(source: { page_id: string; origin: string }): string {
  return `${source.page_id}\u0000${source.origin}`;
}

function sourceKey(pageId: string, origin: db.WikiOrigin): string {
  return `${pageId}\u0000${origin}`;
}
