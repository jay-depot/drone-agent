import { defaultWikiIndexConfig, listPages } from 'drone-swarm-common';
import type { DroneWikiPageMeta } from 'drone-core';

import { logger } from './logger.js';
import { proxyWikiToCoordinator } from './routes/context.js';
import { WikiIndexer } from './wiki-indexer.js';
import type { WikiPageInput, WikiIndexResult } from './wiki-indexer.js';

/** Result of collecting the merged authoritative wiki page set. */
export interface CollectedWikiPages {
  pages: WikiPageInput[];
  coordinatorReachable: boolean;
}

/**
 * Collect the authoritative wiki corpus: beacon-local pages (content read
 * from local storage) plus coordinator pages (content fetched page-by-page
 * as explicit content). A coordinator fetch failure is recorded in
 * `coordinatorReachable=false` and MUST narrow the reconcile scope (see
 * indexWiki's reconcileOrigins contract) — a failed fetch is never an
 * authoritative empty set.
 */
export async function collectWikiPages(): Promise<CollectedWikiPages> {
  const localMetas: DroneWikiPageMeta[] = await listPages();
  let coordinatorReachable = false;
  const coordinatorInputs: WikiPageInput[] = [];

  try {
    const coordinatorPages = (await proxyWikiToCoordinator('GET', '/wiki')) as
      DroneWikiPageMeta[] | null;
    if (Array.isArray(coordinatorPages) && coordinatorPages.length >= 0) {
      coordinatorReachable = true;
      for (const meta of coordinatorPages) {
        coordinatorInputs.push({ page: meta, origin: 'coordinator' });
      }
    }
  } catch {
    coordinatorReachable = false;
  }

  if (!coordinatorReachable) {
    logger.warn(
      'Wiki index: coordinator page list unavailable — reconciling beacon-origin entries only'
    );
  }

  const localInputs: WikiPageInput[] = [];
  for (const meta of localMetas) {
    localInputs.push({ page: meta, origin: 'beacon', content: undefined });
  }

  return {
    pages: [...localInputs, ...coordinatorInputs],
    coordinatorReachable,
  };
}

/**
 * Run a guarded index cycle: collect the merged corpus (with the
 * coordinator-failure guard) and reconcile+index it.
 */
export async function runWikiIndexCycle(
  indexer: WikiIndexer
): Promise<WikiIndexResult | null> {
  return indexer.runCycle(async () => {
    const { pages, coordinatorReachable } = await collectWikiPages();
    const reconcileOrigins: WikiPageInput['origin'][] = coordinatorReachable
      ? ['beacon', 'coordinator']
      : ['beacon'];
    return indexer.indexWiki(pages, reconcileOrigins);
  });
}

// ── Module-level indexer accessor ──────────────────────────────────────

let wikiIndexer: WikiIndexer | undefined;

export function setWikiIndexer(indexer: WikiIndexer | undefined): void {
  wikiIndexer = indexer;
}

export function getWikiIndexer(): WikiIndexer | undefined {
  return wikiIndexer;
}

let reindexDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let writeReindexDebounceMs = defaultWikiIndexConfig().writeReindexDebounceMs;

export function setWikiReindexDebounceMs(ms: number): void {
  writeReindexDebounceMs = ms;
}

/**
 * Coalesce a burst of local wiki writes into one index cycle. Repeated calls
 * inside the window reset the timer, so N writes cause one sweep. The timer is
 * unref'd so a pending reindex can never hold the process open past shutdown.
 */
export function triggerWikiReindex(): void {
  if (reindexDebounceTimer) clearTimeout(reindexDebounceTimer);
  reindexDebounceTimer = setTimeout(() => {
    reindexDebounceTimer = null;
    const indexer = getWikiIndexer();
    if (!indexer) return;
    runWikiIndexCycle(indexer)
      .then(result => {
        if (result === null) {
          // A periodic sweep holds the in-flight guard, so this write was not
          // indexed. Re-arm through the same debounce delay so the write is
          // picked up once the running sweep finishes — never a tight loop.
          triggerWikiReindex();
        }
      })
      .catch(err => {
        logger.warn(`Wiki index: post-write reindex failed: ${err}`);
      });
  }, writeReindexDebounceMs);
  reindexDebounceTimer.unref();
}
