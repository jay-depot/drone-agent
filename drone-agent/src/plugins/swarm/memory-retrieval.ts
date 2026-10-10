import { MAX_PITCH_CHARS } from 'drone-swarm-common';
import type { DroneSwarmCapability, DroneSwarmMemoryConfig } from 'drone-core';

import { buildQueryInputs } from './memory-query.js';
import type { WindowParts } from './memory-window.js';

/**
 * One injected RAG entry after merge/boost/filter. `wiki` entries come from
 * the beacon's merged wiki corpus; `file` entries come from workspace folders
 * opted in via `search.paths[].ragSource`. Both kinds compete for the same
 * `swarm.memory.topK` slots.
 */
export type SwarmMemoryEntry =
  | {
      kind: 'wiki';
      pageId: string;
      origin: 'beacon' | 'coordinator';
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

/** A workspace folder opted into swarm-memory RAG via `search.paths[].ragSource`. */
export type RagSourcePath = { path: string; exclude?: string[] };

export interface SwarmMemoryCache {
  hash: string;
  entries: SwarmMemoryEntry[];
  at: number;
}

export interface SearchRouteResult {
  pageId: string;
  origin: 'beacon' | 'coordinator';
  title: string;
  tags?: string[];
  score: number;
  matchedChunk: string;
  pitch?: string;
}

export interface SearchRouteResponse {
  query: string;
  resultCount: number;
  pageCount: number;
  results: SearchRouteResult[];
}

export interface WorkspaceSearchResult {
  file: string;
  chunkIndex: number;
  content: string;
  score: number;
}

export interface WorkspaceSearchResponse {
  query: string;
  resultCount: number;
  truncated: boolean;
  results: WorkspaceSearchResult[];
}

export interface SwarmMemoryRetrieverDeps {
  /** Swarm connection. Optional: absent until the beacon link is live; the retriever stays inert. */
  capability?: DroneSwarmCapability | null;
  config: DroneSwarmMemoryConfig;
  /** Workspace folders opted into RAG via `search.paths[].ragSource`. */
  ragSourcePaths?: RagSourcePath[];
  debugFlags?: { isEnabled(name: string): boolean };
  logger?: { warn(...args: unknown[]): void; info(...args: unknown[]): void };
  /** Optional one-line status surface (e.g. the TUI chat log via a notice event). */
  emitNotice?: (content: string) => void;
  fetchImpl?: typeof fetch;
}

function formatCacheReport(cache: SwarmMemoryCache | null): string {
  if (!cache) {
    return 'Swarm memory: ON, no retrieval yet (waiting for the next prompt).';
  }
  const ageSec = Math.max(0, Math.round((Date.now() - cache.at) / 1000));
  const lines = [
    `Swarm memory: ON — last refresh ${ageSec}s ago, hash ${cache.hash.slice(0, 12)}, ${cache.entries.length} entries`,
  ];
  for (const entry of cache.entries) {
    lines.push(
      entry.kind === 'wiki'
        ? `  - ${entry.title} · ${entry.pageId} (${entry.origin}) · ${entry.score.toFixed(2)}`
        : `  - ${entry.filePath} · ${entry.score.toFixed(2)}`
    );
  }
  return lines.join('\n');
}

/**
 * Collapse whitespace and cap a pitch to one line. Pitches at the storage
 * maximum (`MAX_PITCH_CHARS`) pass through untouched; anything longer is
 * truncated and gains a trailing ellipsis (one char past the max).
 */
function truncatePitch(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_PITCH_CHARS) return oneLine;
  return `${oneLine.slice(0, MAX_PITCH_CHARS)}…`;
}

/**
 * Client for the beacon's stateless `GET /wiki/semantic-search` route (wiki
 * corpus) and `GET /agents/:id/search` route (workspace folders opted in via
 * `search.paths[].ragSource`), with hash-debounced caching and per-document
 * max-score merging across query inputs and both kinds. The prompt fragment
 * reads the cache ONLY — this class is the sole network participant.
 * `enabled:false` (or a missing swarm connection) makes every method a no-op
 * with zero network calls.
 */
export class SwarmMemoryRetriever {
  private capability: DroneSwarmCapability | null;
  private config: DroneSwarmMemoryConfig;
  private ragSourcePaths: RagSourcePath[];
  private debugFlags?: SwarmMemoryRetrieverDeps['debugFlags'];
  private logger: NonNullable<SwarmMemoryRetrieverDeps['logger']>;
  private emitNotice: (content: string) => void;
  private fetchImpl: typeof fetch;
  private cache: SwarmMemoryCache | null = null;
  private inflight = false;
  private sessionEnabled = true;

  constructor(deps: SwarmMemoryRetrieverDeps) {
    this.capability = deps.capability ?? null;
    this.config = deps.config;
    this.ragSourcePaths = deps.ragSourcePaths ?? [];
    this.debugFlags = deps.debugFlags;
    this.emitNotice = deps.emitNotice ?? (() => {});
    this.logger = deps.logger ?? {
      warn: (...a: unknown[]) => console.warn(...a),
      info: (...a: unknown[]) => console.info(...a),
    };
    this.fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  setCapability(capability: DroneSwarmCapability | null): void {
    this.capability = capability;
  }

  setConfig(config: DroneSwarmMemoryConfig): void {
    this.config = config;
  }

  setSessionEnabled(enabled: boolean): void {
    this.sessionEnabled = enabled;
  }

  isSessionEnabled(): boolean {
    return this.sessionEnabled;
  }

  isEnabled(): boolean {
    return (
      this.config.enabled && this.sessionEnabled && this.capability !== null
    );
  }

  /** Human-readable status for the /swarm-memory slash command. */
  getReport(): string {
    if (!this.isEnabled()) {
      const reason = !this.config.enabled
        ? 'disabled in config (swarm.memory.enabled)'
        : this.capability === null
          ? 'no swarm connection'
          : 'suppressed for this session';
      return `Swarm memory: OFF — ${reason}`;
    }
    return formatCacheReport(this.cache);
  }

  getCache(): SwarmMemoryCache | null {
    return this.cache;
  }

  /** Direct cache injection (test seam). */
  setCacheForTest(entries: SwarmMemoryEntry[]): void {
    this.cache = {
      hash: this.cache?.hash ?? 'injected\u0000cache',
      entries,
      at: this.cache?.at ?? Date.now(),
    };
  }

  private windowSource: (() => WindowParts) | null = null;

  /** Register the window supplier (the conversation tracker's assemble()). */
  setWindowSource(source: () => WindowParts): void {
    this.windowSource = source;
  }

  /**
   * Runtime override that forces a refresh bypassing the debounce hash,
   * using the currently tracked window. No-op when disabled.
   */
  async forceRefreshWindow(): Promise<SwarmMemoryEntry[]> {
    return this.forceRefresh(
      this.windowSource?.() ?? {
        currentQuery: '',
        prevUserQuery: '',
        prevSteering: [],
        prevResponse: '',
      }
    );
  }

  /** Runtime override that forces a refresh bypassing the debounce hash. */
  async forceRefresh(parts: WindowParts): Promise<SwarmMemoryEntry[]> {
    if (!this.isEnabled()) return this.cache?.entries ?? [];
    this.cache = null;
    return this.maybeRefresh(parts);
  }

  /**
   * Refresh the cache if the assembled query inputs changed. Debounced on the
   * sha256 of the final query inputs; in-flight refreshes coalesce; failures
   * keep the previous cache. Returns the current cached entries.
   */
  async maybeRefresh(parts: WindowParts): Promise<SwarmMemoryEntry[]> {
    if (!this.isEnabled()) {
      return this.cache?.entries ?? [];
    }
    const { inputs, hash } = buildQueryInputs(parts, {
      maxQueryTokens: this.config.window?.maxQueryTokens ?? 6000,
      maxQuerySegments: this.config.window?.maxQuerySegments ?? 3,
    });
    if (this.cache && this.cache.hash === hash) {
      return this.cache.entries;
    }
    if (this.inflight || inputs.length === 0) {
      return this.cache?.entries ?? [];
    }

    this.inflight = true;
    try {
      const merged = await this.retrieve(inputs);
      this.cache = { hash, entries: merged, at: Date.now() };
      this.emitNotice(
        `[swarm.memory: found ${merged.length} match${merged.length === 1 ? '' : 'es'}]`
      );
      if (this.debugFlags?.isEnabled('swarm-memory')) {
        this.logger.info(
          `swarm-memory refresh hash=${hash.slice(0, 12)} inputs=${inputs.length} → ${merged.length} entries`
        );
      }
      return merged;
    } catch (err) {
      if (this.debugFlags?.isEnabled('swarm-memory')) {
        this.logger.warn(
          `swarm-memory refresh failed (keeping last cache): ${err}`
        );
      }
      return this.cache?.entries ?? [];
    } finally {
      this.inflight = false;
    }
  }

  private async retrieve(inputs: string[]): Promise<SwarmMemoryEntry[]> {
    const base = this.capability!.getBeaconUrl();
    const agentId = this.capability!.getAgentId();
    const topK = this.config.topK ?? 5;
    const minScore = this.config.minScore ?? 0.35;

    const wikiRequests = inputs.map(async q => {
      const searchParams = new URLSearchParams({
        q,
        maxResults: String(topK),
        minScore: String(minScore),
      });
      const res = await this.fetchImpl(
        `${base}/wiki/semantic-search?${searchParams.toString()}`
      );
      if (!res.ok) {
        throw new Error(`semantic search failed: ${res.status}`);
      }
      return (await res.json()) as SearchRouteResponse;
    });

    const fileRequests = inputs.flatMap(q =>
      this.ragSourcePaths.map(async dir => {
        const searchParams = new URLSearchParams({
          q,
          maxResults: String(topK),
          minScore: String(minScore),
          // Send the RAW configured path: the beacon resolves it with
          // path.resolve at both registration and query time, so the
          // authorization check (startsWith) matches.
          path: dir.path,
        });
        for (const e of dir.exclude ?? []) searchParams.append('exclude', e);
        const res = await this.fetchImpl(
          `${base}/agents/${agentId}/search?${searchParams.toString()}`
        );
        if (!res.ok) {
          throw new Error(`workspace search failed: ${res.status}`);
        }
        return (await res.json()) as WorkspaceSearchResponse;
      })
    );

    const [wikiResponses, fileResponses] = await Promise.all([
      Promise.all(wikiRequests),
      Promise.all(fileRequests),
    ]);

    // Merge per-document MAX score across all query inputs and both kinds.
    const byKey = new Map<string, SwarmMemoryEntry>();
    for (const response of wikiResponses) {
      for (const result of response.results) {
        const key = `wiki\u0000${result.pageId}\u0000${result.origin}`;
        const entry: SwarmMemoryEntry = {
          kind: 'wiki',
          pageId: result.pageId,
          origin: result.origin,
          title: result.title,
          tags: result.tags ?? [],
          score: result.score,
          pitch: truncatePitch(result.pitch ?? result.matchedChunk ?? ''),
        };
        const existing = byKey.get(key);
        if (!existing || entry.score > existing.score) {
          byKey.set(key, entry);
        }
      }
    }
    for (const response of fileResponses) {
      for (const result of response.results) {
        const key = `file\u0000${result.file}`;
        const entry: SwarmMemoryEntry = {
          kind: 'file',
          filePath: result.file,
          score: result.score,
          snippet: truncatePitch(result.content),
        };
        const existing = byKey.get(key);
        if (!existing || entry.score > existing.score) {
          byKey.set(key, entry);
        }
      }
    }

    this.applyAnchorBoosts(byKey);

    return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * Additive configurable anchor boosts. Wiki entries match anchors against
   * their tags (per-tag boost) and title (title boost). File entries have no
   * tags, so their path stands in for the title to keep anchor matching
   * symmetric across kinds.
   */
  private applyAnchorBoosts(byKey: Map<string, SwarmMemoryEntry>): void {
    const anchors = this.config.anchors;
    if (!anchors || anchors.tags.length === 0) return;
    const boostPerTag = anchors.boostPerTag ?? 0.08;
    const boostTitle = anchors.boostTitle ?? 0.05;
    const lowered = anchors.tags.map(t => t.toLowerCase());
    for (const entry of byKey.values()) {
      const titleLower =
        entry.kind === 'wiki'
          ? entry.title.toLowerCase()
          : entry.filePath.toLowerCase();
      const tagsLower =
        entry.kind === 'wiki' ? entry.tags.map(t => t.toLowerCase()) : [];
      for (const anchor of lowered) {
        const tagHit = tagsLower.includes(anchor);
        const titleHit = titleLower.includes(anchor);
        if (tagHit) entry.score += boostPerTag;
        if (titleHit) entry.score += boostTitle;
      }
    }
  }
}
