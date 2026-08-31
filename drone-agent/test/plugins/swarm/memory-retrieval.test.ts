import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DroneSwarmCapability, DroneSwarmMemoryConfig } from 'drone-core';

import { SwarmMemoryRetriever } from '../../../src/plugins/swarm/memory-retrieval.js';
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

function searchResponse(
  entries: Array<{
    pageId: string;
    title: string;
    score: number;
    matchedChunk: string;
    tags?: string[];
    origin?: 'beacon' | 'coordinator';
  }>
): unknown {
  return {
    query: 'q',
    resultCount: entries.length,
    pageCount: entries.length,
    results: entries.map(e => ({ origin: 'beacon' as const, ...e })),
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

  function makeRetriever(
    cfg: DroneSwarmMemoryConfig = config()
  ): SwarmMemoryRetriever {
    const capability: DroneSwarmCapability = {
      getBeaconUrl: () => 'http://beacon:3457',
      getAgentId: () => 'agent-1',
    };
    return new SwarmMemoryRetriever({
      capability,
      config: cfg,
      fetchImpl: fetchMock as unknown as typeof fetch,
      logger: { warn: vi.fn(), info: vi.fn() },
    });
  }

  beforeEach(() => {
    fetchMock = vi.fn();
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
    expect(entries[0].pageId).toBe('fragments');
    expect(entries[0].pitch).toContain('TTL sweep');
    expect(entries[0].pitch.length).toBeLessThanOrEqual(240);
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
    const p1 = entries.find(e => e.pageId === 'p1');
    expect(p1?.score).toBe(0.88);
    expect(p1?.pitch).toBe('better hit');
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

    const beaconEntry = entries.find(e => e.pageId === 'beacon-doc');
    const otherEntry = entries.find(e => e.pageId === 'other-doc');
    expect(beaconEntry?.score).toBeCloseTo(0.63, 5);
    expect(otherEntry?.score).toBeCloseTo(0.5, 5);
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
    expect(retriever.getCache()?.entries[0].pageId).toBe('good');
  });

  it('makes zero network calls when disabled (config or session override or no swarm)', async () => {
    const disabled = makeRetriever(config({ enabled: false }));
    await disabled.maybeRefresh(parts({ currentQuery: 'anything' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(disabled.getCache()).toBeNull();

    fetchMock.mockClear();
    const sessionOff = makeRetriever(config());
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
});
