import type {
  DroneSwarmCapability,
  DroneSwarmMemoryConfig,
} from 'drone-core';

import {
  buildQueryInputs,
} from './memory-query.js';
import type { WindowParts } from './memory-window.js';

/** One injected wiki entry after merge/boost/filter. */
export interface SwarmMemoryEntry {
  pageId: string;
  origin: 'beacon' | 'coordinator';
  title: string;
  tags: string[];
  score: number;
  pitch: string;
}

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
}

export interface SearchRouteResponse {
  query: string;
  resultCount: number;
  pageCount: number;
  results: SearchRouteResult[];
}

export interface SwarmMemoryRetrieverDeps {
  /** Swarm connection. Optional: absent until the beacon link is live; the retriever stays inert. */
  capability?: DroneSwarmCapability | null;
  config: DroneSwarmMemoryConfig;
  debugFlags?: { isEnabled(name: string): boolean };
  logger?: { warn(...args: unknown[]): void; info(...args: unknown[]): void };
  fetchImpl?: typeof fetch;
}

const PITCH_MAX_CHARS = 240;

function formatCacheReport(
  cache: SwarmMemoryCache | null
): string {
  if (!cache) {
    return 'Swarm memory: ON, no retrieval yet (waiting for the next prompt).';
  }
  const ageSec = Math.max(0, Math.round((Date.now() - cache.at) / 1000));
  const lines = [
    `Swarm memory: ON — last refresh ${ageSec}s ago, hash ${cache.hash.slice(0, 12)}, ${cache.entries.length} entries`,
  ];
  for (const entry of cache.entries) {
    lines.push(`  - ${entry.title} · ${entry.pageId} (${entry.origin}) · ${entry.score.toFixed(2)}`);
  }
  return lines.join('\n');
}

function truncatePitch(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= PITCH_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, PITCH_MAX_CHARS - 1)}…`;
}

/**
 * Client for the beacon's stateless `GET /wiki/semantic-search` route, with
 * hash-debounced caching and per-document max-score merging across query
 * inputs. The prompt fragment reads the cache ONLY — this class is the sole
 * network participant. `enabled:false` (or a missing swarm connection) makes
 * every method a no-op with zero network calls.
 */
export class SwarmMemoryRetriever {
  private capability: DroneSwarmCapability | null;
  private config: DroneSwarmMemoryConfig;
  private debugFlags?: SwarmMemoryRetrieverDeps['debugFlags'];
  private logger: NonNullable<SwarmMemoryRetrieverDeps['logger']>;
  private fetchImpl: typeof fetch;
  private cache: SwarmMemoryCache | null = null;
  private inflight = false;
  private sessionEnabled = true;

  constructor(deps: SwarmMemoryRetrieverDeps) {
    this.capability = deps.capability ?? null;
    this.config = deps.config;
    this.debugFlags = deps.debugFlags;
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
    return this.config.enabled && this.sessionEnabled && this.capability !== null;
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
    return this.forceRefresh(this.windowSource?.() ?? {
      currentQuery: '',
      prevUserQuery: '',
      prevSteering: [],
      prevResponse: '',
    });
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
      if (this.debugFlags?.isEnabled('swarm-memory')) {
        this.logger.info(
          `swarm-memory refresh hash=${hash.slice(0, 12)} inputs=${inputs.length} → ${merged.length} entries`
        );
      }
      return merged;
    } catch (err) {
      if (this.debugFlags?.isEnabled('swarm-memory')) {
        this.logger.warn(`swarm-memory refresh failed (keeping last cache): ${err}`);
      }
      return this.cache?.entries ?? [];
    } finally {
      this.inflight = false;
    }
  }

  private async retrieve(inputs: string[]): Promise<SwarmMemoryEntry[]> {
    const base = this.capability!.getBeaconUrl();
    const params = new URLSearchParams({
      maxResults: String(this.config.topK ?? 5),
    });
    const minScore = this.config.minScore ?? 0.35;
    params.set('minScore', String(minScore));

    const responses = await Promise.all(
      inputs.map(async q => {
        const searchParams = new URLSearchParams(params);
        searchParams.set('q', q);
        const res = await this.fetchImpl(
          `${base}/wiki/semantic-search?${searchParams.toString()}`
        );
        if (!res.ok) {
          throw new Error(`semantic search failed: ${res.status}`);
        }
        return (await res.json()) as SearchRouteResponse;
      })
    );

    // Merge per-document MAX score across all query inputs.
    const byKey = new Map<string, SwarmMemoryEntry>();
    for (const response of responses) {
      for (const result of response.results) {
        const key = `${result.pageId}\u0000${result.origin}`;
        const entry: SwarmMemoryEntry = {
          pageId: result.pageId,
          origin: result.origin,
          title: result.title,
          tags: result.tags ?? [],
          score: result.score,
          pitch: truncatePitch(result.matchedChunk ?? ''),
        };
        const existing = byKey.get(key);
        if (!existing || entry.score > existing.score) {
          byKey.set(key, entry);
        }
      }
    }

    // Additive configurable anchor boosts.
    const anchors = this.config.anchors;
    if (anchors && anchors.tags.length > 0) {
      const boostPerTag = anchors.boostPerTag ?? 0.08;
      const boostTitle = anchors.boostTitle ?? 0;
      const lowered = anchors.tags.map(t => t.toLowerCase());
      for (const entry of byKey.values()) {
        const titleLower = entry.title.toLowerCase();
        const tagsLower = (entry.tags ?? []).map(t => t.toLowerCase());
        for (const anchor of lowered) {
          const tagHit = tagsLower.includes(anchor);
          const titleHit = titleLower.includes(anchor);
          if (tagHit) entry.score += boostPerTag;
          if (titleHit) entry.score += boostTitle;
        }
      }
    }

    return [...byKey.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.topK ?? 5);
  }
}