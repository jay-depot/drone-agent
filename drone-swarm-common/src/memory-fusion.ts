/**
 * Swarm-memory result fusion.
 *
 * Merges per-query-input, per-kind search results into one ranked list:
 * per-document MAX across inputs and kinds, an additive keyword-coverage
 * boost for wiki pages, additive anchor boosts, then a `minScore` floor and a
 * `topK` slice.
 *
 * Pure and deterministic — the beacon does the I/O, this decides the ranking.
 *
 * ## Why additive rather than a convex blend
 *
 * Wiki and file entries compete for the same slots. Scaling only the wiki side
 * (e.g. `0.7*cos + 0.3*coverage`) multiplies every wiki score by 0.7 while file
 * scores stay raw cosine, systematically demoting wiki pages against file hits
 * for reasons unrelated to relevance. Adding a bounded bonus instead leaves an
 * entry with no keyword match at exactly its cosine.
 *
 * Scores can therefore exceed 1.0 (cosine 1.0 + boost). Only ordering and the
 * `minScore` floor consume them.
 */

import type { RankingConfig } from './config-file.js';

export type SwarmMemoryEntry =
  | {
      kind: 'wiki';
      pageId: string;
      origin: string;
      title: string;
      tags: string[];
      score: number;
      pitch: string;
    }
  | {
      kind: 'file';
      filePath: string;
      score: number;
      snippet: string;
    };

export type WikiCandidate = {
  pageId: string;
  origin: string;
  title: string;
  tags: string[];
  score: number;
  pitch?: string;
  /** Used as the pitch when the page has no curated one. */
  matchedChunk?: string;
};

export type FileCandidate = {
  filePath: string;
  score: number;
  snippet: string;
};

export type MemoryFusionInput = {
  /** Cosine results from every query input (already flattened). */
  wiki: WikiCandidate[];
  files: FileCandidate[];
  /**
   * Keyword coverage per wiki page, keyed `origin\u0000pageId`, each in [0, 1].
   *
   * Coverage is computed against the current user query only — scoring it
   * against a long assembled window would drive it to ~0 for every page.
   */
  coverage?: Map<string, number>;
  ranking: RankingConfig;
};

/** Stable fusion key for a wiki page. */
export function wikiKey(origin: string, pageId: string): string {
  return `${origin}\u0000${pageId}`;
}

function truncatePitch(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars)}…`;
}

function applyAnchorBoosts(
  entries: SwarmMemoryEntry[],
  ranking: RankingConfig
): void {
  const anchors = ranking.anchors;
  if (!anchors || anchors.tags.length === 0) return;
  const lowered = anchors.tags.map(t => t.toLowerCase());
  for (const entry of entries) {
    const titleLower =
      entry.kind === 'wiki'
        ? entry.title.toLowerCase()
        : entry.filePath.toLowerCase();
    const tagsLower =
      entry.kind === 'wiki' ? entry.tags.map(t => t.toLowerCase()) : [];
    for (const anchor of lowered) {
      if (tagsLower.includes(anchor)) entry.score += anchors.boostPerTag;
      if (titleLower.includes(anchor)) entry.score += anchors.boostTitle;
    }
  }
}

/**
 * Fuse candidate results into the final ranked list.
 *
 * `maxPitchChars` bounds the injected pitch/snippet; it is a parameter rather
 * than an import so this module stays free of presentation constants.
 */
export function fuseMemoryResults(
  input: MemoryFusionInput,
  maxPitchChars: number
): SwarmMemoryEntry[] {
  const { ranking } = input;
  const coverage = input.coverage ?? new Map<string, number>();

  const byKey = new Map<string, SwarmMemoryEntry>();

  for (const hit of input.wiki) {
    const key = `wiki\u0000${wikiKey(hit.origin, hit.pageId)}`;
    const existing = byKey.get(key);
    // Per-document MAX: the best-scoring chunk across all query inputs wins.
    if (existing && existing.score >= hit.score) continue;
    byKey.set(key, {
      kind: 'wiki',
      pageId: hit.pageId,
      origin: hit.origin,
      title: hit.title,
      tags: hit.tags,
      score: hit.score,
      pitch: truncatePitch(hit.pitch ?? hit.matchedChunk ?? '', maxPitchChars),
    });
  }

  for (const hit of input.files) {
    const key = `file\u0000${hit.filePath}`;
    const existing = byKey.get(key);
    if (existing && existing.score >= hit.score) continue;
    byKey.set(key, {
      kind: 'file',
      filePath: hit.filePath,
      score: hit.score,
      snippet: truncatePitch(hit.snippet, maxPitchChars),
    });
  }

  // Keyword coverage applies to wiki pages only: the index is beacon-local.
  // A page can be lifted over the floor by keyword evidence alone, which is
  // the point of applying the floor after fusion rather than before.
  for (const entry of byKey.values()) {
    if (entry.kind !== 'wiki') continue;
    const cov = coverage.get(wikiKey(entry.origin, entry.pageId));
    if (cov !== undefined && cov > 0) {
      entry.score += ranking.keywordBoost * cov;
    }
  }

  const entries = [...byKey.values()];
  applyAnchorBoosts(entries, ranking);

  return entries
    .filter(e => e.score >= ranking.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, ranking.topK);
}
