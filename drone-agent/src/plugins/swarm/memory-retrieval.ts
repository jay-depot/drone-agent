import type { DroneSwarmCapability, DroneSwarmMemoryConfig } from 'drone-core';

import { buildQueryInputs } from './memory-query.js';
import type { WindowParts } from './memory-window.js';

/**
 * One injected RAG entry, as fused and ranked by the beacon. `wiki` entries
 * come from the beacon's merged wiki corpus; `file` entries come from
 * workspace folders opted in via `search.paths[].ragSource`. Both kinds
 * compete for the same `ranking.topK` slots (beacon config).
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

/**
 * One entry as returned by the beacon's `POST /swarm-memory/retrieve`.
 *
 * Mirrors the beacon's fused entry shape, except `origin` arrives as a plain
 * string over the wire and is narrowed by {@link narrowEntry} at this
 * boundary.
 */
type BeaconMemoryEntry =
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

/** Narrow a wire entry to the agent-side union, defaulting an unknown origin. */
function narrowEntry(entry: BeaconMemoryEntry): SwarmMemoryEntry {
  if (entry.kind === 'file') {
    return {
      kind: 'file',
      filePath: entry.filePath,
      score: entry.score,
      snippet: entry.snippet,
    };
  }
  return {
    kind: 'wiki',
    pageId: entry.pageId,
    origin: entry.origin === 'coordinator' ? 'coordinator' : 'beacon',
    title: entry.title,
    tags: entry.tags,
    score: entry.score,
    // The beacon always sends a string, but this is a network boundary — a
    // malformed payload must not crash the fragment renderer.
    pitch: entry.pitch ?? '',
  };
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
 * Client for the beacon's `POST /swarm-memory/retrieve` route, with
 * hash-debounced caching. The beacon owns fan-out, fusion and ranking; this
 * class owns the assembled query inputs and the cache. The prompt fragment
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

    // One request replaces the previous per-input × per-source fan-out.
    // Fusion, keyword coverage and anchor boosts all happen on the beacon, so
    // ranking stays a property of the corpus rather than of this agent.
    const res = await this.fetchImpl(`${base}/swarm-memory/retrieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId,
        inputs,
        // The beacon knows which directories this agent registered, but not
        // their exclude globs, so they travel with the request.
        paths: this.ragSourcePaths.map(dir => ({
          path: dir.path,
          ...(dir.exclude ? { exclude: dir.exclude } : {}),
        })),
      }),
    });
    if (!res.ok) {
      throw new Error(`swarm-memory retrieve failed: ${res.status}`);
    }
    const entries = (await res.json()) as BeaconMemoryEntry[];
    if (!Array.isArray(entries)) {
      throw new Error('swarm-memory retrieve returned a non-array payload');
    }
    return entries.map(narrowEntry);
  }
}
