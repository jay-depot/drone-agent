import { createHash } from 'node:crypto';
import type { DroneEmbeddingProvider, DroneWikiPageMeta } from 'drone-core';
import {
  chunkMarkdown,
  defaultWikiIndexConfig,
  hasWikiFtsRows,
  replaceWikiFtsRows,
} from 'drone-swarm-common';

import { logger } from './logger.js';
import { sleep } from './util.js';
import * as db from './db/index.js';

const CHUNK_TARGET_TOKENS = 480;

export interface WikiPageInput {
  page: DroneWikiPageMeta;
  origin: db.WikiOrigin;
  /**
   * Page body. When omitted the indexer reads it lazily — from local storage
   * for beacon pages, or via a per-page coordinator fetch for coordinator
   * pages.
   */
  content?: string;
}

export interface WikiIndexResult {
  pagesIndexed: number;
  pagesSkipped: number;
  pagesRemoved: number;
  chunksCreated: number;
  /** Pages whose keyword-index rows were rebuilt from stored chunks. */
  ftsRepaired: number;
}

function pageHash(
  pageId: string,
  origin: string,
  updatedAt: string,
  fingerprint: string
): string {
  return createHash('sha256')
    .update(fingerprint)
    .update('\u0000')
    .update(`${pageId}\u0000${origin}\u0000${updatedAt}`)
    .digest('hex');
}

function emptyResult(): WikiIndexResult {
  return {
    pagesIndexed: 0,
    pagesSkipped: 0,
    pagesRemoved: 0,
    chunksCreated: 0,
    ftsRepaired: 0,
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
  private fingerprint: string;
  private pacingMs: number;
  private cycleRunning = false;

  constructor(
    provider?: DroneEmbeddingProvider,
    sweepIntervalMs: number = defaultWikiIndexConfig().sweepIntervalMs,
    fingerprint: string = '',
    pacingMs: number = defaultWikiIndexConfig().pacingMs
  ) {
    this.provider = provider ?? null;
    this.sweepIntervalMs = sweepIntervalMs;
    this.fingerprint = fingerprint;
    this.pacingMs = pacingMs;
  }

  setProvider(provider: DroneEmbeddingProvider): void {
    this.provider = provider;
  }

  getProvider(): DroneEmbeddingProvider | null {
    return this.provider;
  }

  /**
   * Run one index cycle. A second call while a cycle runs is a no-op, so
   * periodic ticks and write bursts cannot overlap into extra sweeps.
   */
  async runCycle<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.cycleRunning) {
      logger.info('Wiki index: cycle already running, skipping');
      return null;
    }
    this.cycleRunning = true;
    try {
      return await fn();
    } finally {
      this.cycleRunning = false;
    }
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

    // Snapshot the stored source rows once. This query aggregates every source
    // against every chunk, so calling it per page made a sweep O(pages²) —
    // thousands of full GROUP BY scans per pass to answer a question whose
    // answer does not change while the loop runs. Each (page_id, origin) is
    // visited at most once below, so one snapshot is equivalent to a live
    // lookup per page.
    const storedByKey = new Map(
      db.getWikiSourcesWithChunkCounts().map(s => [sourceKeyOf(s), s] as const)
    );

    for (const entry of pages) {
      try {
        const hash = pageHash(
          entry.page.id,
          entry.origin,
          entry.page.updatedAt,
          this.fingerprint
        );
        const stored = storedByKey.get(sourceKey(entry.page.id, entry.origin));

        // Skip only when the hash matches AND chunks exist. A page recorded as
        // indexed with zero chunks (a previous failed embed) must be retried.
        if (stored && stored.hash === hash && stored.chunk_count > 0) {
          // The keyword index post-dates the vector index, so a page can be
          // fully embedded yet absent from FTS. Rebuild those rows from chunk
          // text already in the database — this needs no re-embedding.
          if (
            !hasWikiFtsRows(() => db.getDatabase(), entry.page.id, entry.origin)
          ) {
            const chunks = db.getWikiChunks(entry.page.id, entry.origin);
            if (chunks.length > 0) {
              replaceWikiFtsRows(() => db.getDatabase(), {
                pageId: entry.page.id,
                origin: entry.origin,
                title: entry.page.title,
                tags: entry.page.tags.join(' '),
                ...(entry.page.pitch ? { pitch: entry.page.pitch } : {}),
                body: chunks.map(c => c.text).join('\n\n'),
              });
              result.ftsRepaired++;
            }
          }
          result.pagesSkipped++;
          continue;
        }

        if (
          entry.content === undefined &&
          entry.origin === 'coordinator' &&
          this.pacingMs > 0
        ) {
          await sleep(this.pacingMs);
        }
        const content = await fetchPageContent(entry);
        const chunkTexts = chunkMarkdown(content, CHUNK_TARGET_TOKENS);
        if (chunkTexts.length === 0) {
          db.removeWikiSource(entry.page.id, entry.origin);
          result.pagesRemoved++;
          continue;
        }
        // Embed every chunk first. A throw here leaves no source row and no
        // chunks, so the page is retried on the next pass.
        const embeddings: Float32Array[] = [];
        for (const text of chunkTexts) {
          embeddings.push(
            await provider.embedDocument(text, { title: entry.page.title })
          );
        }

        db.replaceWikiPage(
          entry.page.id,
          entry.origin,
          {
            title: entry.page.title,
            updatedAt: entry.page.updatedAt,
            hash,
          },
          chunkTexts.map((text, index) => ({
            index,
            text,
            embedding: embeddings[index],
          }))
        );
        replaceWikiFtsRows(() => db.getDatabase(), {
          pageId: entry.page.id,
          origin: entry.origin,
          title: entry.page.title,
          tags: entry.page.tags.join(' '),
          ...(entry.page.pitch ? { pitch: entry.page.pitch } : {}),
          body: chunkTexts.join('\n\n'),
        });
        result.chunksCreated += chunkTexts.length;
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
      `Wiki index: ${result.pagesIndexed} indexed, ${result.pagesSkipped} skipped, ${result.pagesRemoved} removed, ${result.chunksCreated} chunks, ${result.ftsRepaired} fts-repaired`
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
