import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DroneSwarmCapability, DroneSwarmMemoryConfig } from 'drone-core';

import {
  SwarmMemoryRetriever,
  type RagSourcePath,
  type SwarmMemoryEntry,
} from '../../../src/plugins/swarm/memory-retrieval.js';
import type { WindowParts } from '../../../src/plugins/swarm/memory-window.js';

function config(
  overrides: Partial<DroneSwarmMemoryConfig> = {}
): DroneSwarmMemoryConfig {
  return {
    enabled: true,
    topK: 5,
    minScore: 0.35,
    anchors: { tags: [], boostPerTag: 0.08, boostTitle: 0.05 },
    window: { maxQueryTokens: 6000, maxQuerySegments: 3 },
    ...overrides,
  };
}

function parts(overrides: Partial<WindowParts> = {}): WindowParts {
  return {
    currentQuery: 'how do fragments expire',
    prevUserQuery: '',
    prevSteering: [],
    prevResponse: '',
    ...overrides,
  };
}

/** Narrows an entry to the wiki variant (or throws). */
function asWiki(entry: SwarmMemoryEntry | undefined) {
  if (!entry || entry.kind !== 'wiki') {
    throw new Error(`expected a wiki entry, got ${JSON.stringify(entry)}`);
  }
  return entry;
}

/** Narrows an entry to the file variant (or throws). */
function asFile(entry: SwarmMemoryEntry | undefined) {
  if (!entry || entry.kind !== 'file') {
    throw new Error(`expected a file entry, got ${JSON.stringify(entry)}`);
  }
  return entry;
}

function searchResponse(
  entries: Array<{
    pageId: string;
    title: string;
    score: number;
    matchedChunk: string;
    tags?: string[];
    origin?: 'beacon' | 'coordinator';
    pitch?: string;
  }>
): unknown {
  return {
    query: 'q',
    resultCount: entries.length,
    pageCount: entries.length,
    results: entries.map(e => ({ origin: 'beacon' as const, ...e })),
  };
}

function workspaceResponse(
  entries: Array<{ file: string; score: number; content: string }>
): unknown {
  return {
    query: 'q',
    resultCount: entries.length,
    truncated: false,
    results: entries.map(e => ({ chunkIndex: 0, ...e })),
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe('SwarmMemoryRetriever', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const notices: string[] = [];

  function makeRetriever(
    cfg: DroneSwarmMemoryConfig = config(),
    ragSourcePaths: RagSourcePath[] = []
  ): SwarmMemoryRetriever {
    const capability: DroneSwarmCapability = {
      getBeaconUrl: () => 'http://beacon:3457',
      getAgentId: () => 'agent-1',
    };
    return new SwarmMemoryRetriever({
      capability,
      config: cfg,
      ragSourcePaths,
      fetchImpl: fetchMock as unknown as typeof fetch,
      logger: { warn: vi.fn(), info: vi.fn() },
      emitNotice: content => notices.push(content),
    });
  }

  /** URLs of every fetch call matching the given path fragment. */
  function callsTo(fragment: string): string[] {
    return fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter(u => u.includes(fragment));
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    notices.length = 0;
  });

  it('retrieves, merges by max score, and caches', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        searchResponse([
          {
            pageId: 'fragments',
            title: 'Fragment Guide',
            score: 0.72,
            matchedChunk:
              'The TTL sweep deletes expired fragments every minute.',
            tags: ['fragments'],
          },
        ])
      )
    );
    const retriever = makeRetriever();
    const entries = await retriever.maybeRefresh(parts());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    const entry = asWiki(entries[0]);
    expect(entry.pageId).toBe('fragments');
    expect(entry.pitch).toContain('TTL sweep');
    expect(entry.pitch.length).toBeLessThanOrEqual(401);
  });

  it('prefers the stored pitch over the matched chunk when both are present', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        searchResponse([
          {
            pageId: 'fragments',
            title: 'Fragment Guide',
            score: 0.72,
            matchedChunk: 'The TTL sweep deletes expired fragments.',
            pitch: 'A curated one-sentence pitch about fragments.',
          },
        ])
      )
    );
    const retriever = makeRetriever();
    const entries = await retriever.maybeRefresh(parts());

    expect(entries).toHaveLength(1);
    expect(asWiki(entries[0]).pitch).toBe(
      'A curated one-sentence pitch about fragments.'
    );
  });

  it('falls back to the matched chunk when no stored pitch is present', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        searchResponse([
          {
            pageId: 'fragments',
            title: 'Fragment Guide',
            score: 0.72,
            matchedChunk: 'The TTL sweep deletes expired fragments.',
          },
        ])
      )
    );
    const retriever = makeRetriever();
    const entries = await retriever.maybeRefresh(parts());

    expect(entries).toHaveLength(1);
    expect(asWiki(entries[0]).pitch).toBe(
      'The TTL sweep deletes expired fragments.'
    );
  });

  it('debounces identical windows with zero additional network calls', async () => {
    fetchMock.mockResolvedValue(jsonResponse(searchResponse([])));
    const retriever = makeRetriever();

    await retriever.maybeRefresh(
      parts({ currentQuery: 'same window every time' })
    );
    await retriever.maybeRefresh(
      parts({ currentQuery: 'same window every time' })
    );
    await retriever.maybeRefresh(
      parts({ currentQuery: 'same window every time' })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('emits a notice line once per real retrieval, with the match count', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        searchResponse([
          {
            pageId: 'fragments',
            title: 'Fragment Guide',
            score: 0.72,
            matchedChunk: 'TTL sweep',
          },
        ])
      )
    );
    const retriever = makeRetriever();

    await retriever.maybeRefresh(parts({ currentQuery: 'window A' }));
    await retriever.maybeRefresh(parts({ currentQuery: 'window A' }));

    expect(notices).toEqual(['[swarm.memory: found 1 match]']);

    fetchMock.mockResolvedValue(jsonResponse(searchResponse([])));
    await retriever.maybeRefresh(parts({ currentQuery: 'window B' }));
    expect(notices).toEqual([
      '[swarm.memory: found 1 match]',
      '[swarm.memory: found 0 matches]',
    ]);
  });

  it('merges duplicate pages across multiple query inputs by max score', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('q=first')) {
        return jsonResponse(
          searchResponse([
            {
              pageId: 'p1',
              title: 'P1',
              score: 0.42,
              matchedChunk: 'first hit',
            },
          ])
        );
      }
      return jsonResponse(
        searchResponse([
          {
            pageId: 'p1',
            title: 'P1',
            score: 0.88,
            matchedChunk: 'better hit',
          },
          { pageId: 'p2', title: 'P2', score: 0.5, matchedChunk: 'other' },
        ])
      );
    });
    const retriever = makeRetriever();
    const entries = await retriever.maybeRefresh(
      parts({ currentQuery: 'first', prevResponse: 'second query' })
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const p1 = asWiki(
      entries.find(e => e.kind === 'wiki' && e.pageId === 'p1')
    );
    expect(p1.score).toBe(0.88);
    expect(p1.pitch).toBe('better hit');
  });

  it('applies additive anchor boosts for matching tags and titles', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        searchResponse([
          {
            pageId: 'beacon-doc',
            title: 'Beacon internals',
            score: 0.5,
            matchedChunk: 'stuff',
            tags: ['beacon'],
          },
          {
            pageId: 'other-doc',
            title: 'Unrelated',
            score: 0.5,
            matchedChunk: 'stuff',
            tags: ['unrelated'],
          },
        ])
      )
    );
    const retriever = makeRetriever(
      config({
        anchors: { tags: ['beacon'], boostPerTag: 0.08, boostTitle: 0.05 },
      })
    );
    const entries = await retriever.maybeRefresh(parts());

    const beaconEntry = asWiki(
      entries.find(e => e.kind === 'wiki' && e.pageId === 'beacon-doc')
    );
    const otherEntry = asWiki(
      entries.find(e => e.kind === 'wiki' && e.pageId === 'other-doc')
    );
    expect(beaconEntry.score).toBeCloseTo(0.63, 5);
    expect(otherEntry.score).toBeCloseTo(0.5, 5);
  });

  it('keeps the previous cache when retrieval fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          searchResponse([
            {
              pageId: 'good',
              title: 'Good',
              score: 0.9,
              matchedChunk: 'cached entry',
            },
          ])
        )
      )
      .mockRejectedValueOnce(new Error('beacon down'));

    const retriever = makeRetriever();
    await retriever.maybeRefresh(parts({ currentQuery: 'first topic' }));
    expect(retriever.getCache()?.entries).toHaveLength(1);

    const afterFailure = await retriever.maybeRefresh(
      parts({ currentQuery: 'different topic now' })
    );
    expect(afterFailure).toHaveLength(1);
    expect(asWiki(retriever.getCache()?.entries[0]).pageId).toBe('good');
  });

  it('makes zero network calls when disabled (config or session override or no swarm)', async () => {
    const disabled = makeRetriever(config({ enabled: false }));
    await disabled.maybeRefresh(parts({ currentQuery: 'anything' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(disabled.getCache()).toBeNull();

    fetchMock.mockClear();
    const sessionOff = makeRetriever();
    sessionOff.setSessionEnabled(false);
    await sessionOff.maybeRefresh(parts({ currentQuery: 'anything' }));
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockClear();
    const noSwarm = new SwarmMemoryRetriever({
      config: config(),
      fetchImpl: fetchMock as unknown as typeof fetch,
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    expect(noSwarm.isEnabled()).toBe(false);
    await noSwarm.maybeRefresh(parts({ currentQuery: 'anything' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forceRefresh bypasses the debounce hash', async () => {
    fetchMock.mockResolvedValue(jsonResponse(searchResponse([])));
    const retriever = makeRetriever();

    await retriever.maybeRefresh(parts({ currentQuery: 'stable' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await retriever.forceRefresh(parts({ currentQuery: 'stable' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('issues one workspace query per (input × ragSource dir)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(workspaceResponse([])));
    const retriever = makeRetriever(config(), [
      { path: '/proj/one' },
      { path: '/proj/two' },
    ]);

    await retriever.maybeRefresh(
      parts({ currentQuery: 'first', prevResponse: 'second query' })
    );

    // Two query inputs × two ragSource dirs = four workspace calls.
    expect(callsTo('/agents/agent-1/search')).toHaveLength(4);
    // Wiki calls are separate and still one per input.
    expect(callsTo('/wiki/semantic-search')).toHaveLength(2);
  });

  it('sends the raw configured path and forwards exclude globs', async () => {
    fetchMock.mockResolvedValue(jsonResponse(workspaceResponse([])));
    const retriever = makeRetriever(config(), [
      { path: '/proj/raw', exclude: ['*.log', '**/dist/**'] },
    ]);

    await retriever.maybeRefresh(parts({ currentQuery: 'q' }));

    const url = callsTo('/agents/agent-1/search')[0];
    const sp = new URL(url).searchParams;
    expect(sp.get('path')).toBe('/proj/raw');
    expect(sp.getAll('exclude')).toEqual(['*.log', '**/dist/**']);
    expect(sp.get('maxResults')).toBe('5');
    expect(sp.get('minScore')).toBe('0.35');
  });

  it('merges file and wiki hits into one pool truncated to topK', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/wiki/semantic-search')) {
        return jsonResponse(
          searchResponse([
            {
              pageId: 'wiki-high',
              title: 'Wiki High',
              score: 0.9,
              matchedChunk: 'wiki high',
            },
            {
              pageId: 'wiki-low',
              title: 'Wiki Low',
              score: 0.2,
              matchedChunk: 'wiki low',
            },
          ])
        );
      }
      return jsonResponse(
        workspaceResponse([
          { file: '/proj/file-a.ts', score: 0.8, content: 'file a' },
          { file: '/proj/file-b.ts', score: 0.1, content: 'file b' },
        ])
      );
    });
    const retriever = makeRetriever(config({ topK: 2 }), [{ path: '/proj' }]);

    const entries = await retriever.maybeRefresh(parts({ currentQuery: 'q' }));

    // topK=2 — no extra slots for the extra source.
    expect(entries).toHaveLength(2);
    expect(asWiki(entries[0]).pageId).toBe('wiki-high');
    expect(asFile(entries[1]).filePath).toBe('/proj/file-a.ts');
  });

  it('applies anchor title boosts to file paths', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/wiki/semantic-search')) {
        return jsonResponse(searchResponse([]));
      }
      return jsonResponse(
        workspaceResponse([
          { file: '/proj/beacon/thing.ts', score: 0.5, content: 'x' },
          { file: '/proj/other/thing.ts', score: 0.5, content: 'y' },
        ])
      );
    });
    const retriever = makeRetriever(
      config({
        anchors: { tags: ['beacon'], boostPerTag: 0.08, boostTitle: 0.05 },
      }),
      [{ path: '/proj' }]
    );

    const entries = await retriever.maybeRefresh(parts({ currentQuery: 'q' }));

    const hit = asFile(
      entries.find(e => e.kind === 'file' && e.filePath.includes('beacon'))
    );
    const miss = asFile(
      entries.find(e => e.kind === 'file' && e.filePath.includes('other'))
    );
    expect(hit.score).toBeCloseTo(0.55, 5);
    expect(miss.score).toBeCloseTo(0.5, 5);
  });

  it('keeps the previous cache when a workspace query fails', async () => {
    let workspaceDown = false;
    fetchMock.mockImplementation(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/wiki/semantic-search')) {
        return jsonResponse(
          searchResponse([
            {
              pageId: 'good',
              title: 'Good',
              score: 0.9,
              matchedChunk: 'cached entry',
            },
          ])
        );
      }
      if (workspaceDown) throw new Error('workspace down');
      return jsonResponse(workspaceResponse([]));
    });

    const retriever = makeRetriever(config(), [{ path: '/proj' }]);
    await retriever.maybeRefresh(parts({ currentQuery: 'first topic' }));
    expect(asWiki(retriever.getCache()?.entries[0]).pageId).toBe('good');

    workspaceDown = true;
    const afterFailure = await retriever.maybeRefresh(
      parts({ currentQuery: 'different topic now' })
    );
    expect(asWiki(afterFailure[0]).pageId).toBe('good');
  });
});
