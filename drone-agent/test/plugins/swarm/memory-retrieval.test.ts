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

/** A wiki entry shaped as the beacon returns it over the wire. */
function wikiEntry(over: {
  pageId: string;
  title?: string;
  score?: number;
  origin?: string;
  tags?: string[];
  pitch?: string;
}) {
  return {
    kind: 'wiki' as const,
    pageId: over.pageId,
    origin: over.origin ?? 'beacon',
    title: over.title ?? over.pageId,
    tags: over.tags ?? [],
    score: over.score ?? 0.5,
    pitch: over.pitch ?? '',
  };
}

/** A file entry shaped as the beacon returns it over the wire. */
function fileEntry(over: {
  filePath: string;
  score?: number;
  snippet?: string;
}) {
  return {
    kind: 'file' as const,
    filePath: over.filePath,
    score: over.score ?? 0.5,
    snippet: over.snippet ?? '',
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
      registerWsHandler: () => () => {},
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

  /** The parsed body of the single retrieve call, or undefined. */
  function retrieveBody(): Record<string, unknown> | undefined {
    const call = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/swarm-memory/retrieve')
    );
    if (!call) return undefined;
    const init = call[1] as RequestInit | undefined;
    return JSON.parse(String(init?.body ?? '{}'));
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    notices.length = 0;
  });

  it('retrieves the fused list in a single request', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        wikiEntry({
          pageId: 'fragments',
          title: 'Fragment Guide',
          score: 0.72,
          tags: ['fragments'],
          pitch: 'The TTL sweep deletes expired fragments every minute.',
        }),
      ])
    );
    const retriever = makeRetriever();
    const entries = await retriever.maybeRefresh(parts());

    // The whole point of the collapse: exactly one network call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://beacon:3457/swarm-memory/retrieve'
    );
    expect(entries).toHaveLength(1);
    const entry = asWiki(entries[0]);
    expect(entry.pageId).toBe('fragments');
    expect(entry.pitch).toContain('TTL sweep');
  });

  it('sends the assembled query inputs and the agent id', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const retriever = makeRetriever();

    await retriever.maybeRefresh(
      parts({ currentQuery: 'first', prevResponse: 'second query' })
    );

    const body = retrieveBody();
    expect(body?.agentId).toBe('agent-1');
    expect(Array.isArray(body?.inputs)).toBe(true);
    expect((body?.inputs as string[]).length).toBeGreaterThan(0);
  });

  it('forwards ragSource paths with their exclude globs', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const retriever = makeRetriever(config(), [
      { path: '/proj/raw', exclude: ['*.log', '**/dist/**'] },
      { path: '/proj/plain' },
    ]);

    await retriever.maybeRefresh(parts({ currentQuery: 'q' }));

    // The beacon knows the registered directories but not their exclude
    // globs, so they must travel with the request.
    expect(retrieveBody()?.paths).toEqual([
      { path: '/proj/raw', exclude: ['*.log', '**/dist/**'] },
      { path: '/proj/plain' },
    ]);
  });

  it('omits the exclude key for a path without globs', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const retriever = makeRetriever(config(), [{ path: '/proj/plain' }]);

    await retriever.maybeRefresh(parts({ currentQuery: 'q' }));

    const paths = retrieveBody()?.paths as Array<Record<string, unknown>>;
    expect(paths[0]).toEqual({ path: '/proj/plain' });
    expect('exclude' in paths[0]).toBe(false);
  });

  it('narrows an unknown origin to beacon', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([wikiEntry({ pageId: 'p', origin: 'something-else' })])
    );
    const retriever = makeRetriever();

    const entries = await retriever.maybeRefresh(parts({ currentQuery: 'q' }));

    expect(asWiki(entries[0]).origin).toBe('beacon');
  });

  it('preserves a coordinator origin', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([wikiEntry({ pageId: 'p', origin: 'coordinator' })])
    );
    const retriever = makeRetriever();

    const entries = await retriever.maybeRefresh(parts({ currentQuery: 'q' }));

    expect(asWiki(entries[0]).origin).toBe('coordinator');
  });

  it('passes file entries through unchanged', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        fileEntry({ filePath: '/proj/a.ts', score: 0.8, snippet: 'body' }),
      ])
    );
    const retriever = makeRetriever();

    const entries = await retriever.maybeRefresh(parts({ currentQuery: 'q' }));

    const file = asFile(entries[0]);
    expect(file.filePath).toBe('/proj/a.ts');
    expect(file.snippet).toBe('body');
  });

  it('rejects a non-array payload rather than caching garbage', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }));
    const retriever = makeRetriever();

    const entries = await retriever.maybeRefresh(parts({ currentQuery: 'q' }));

    expect(entries).toEqual([]);
    expect(retriever.getCache()).toBeNull();
  });

  it('debounces identical windows with zero additional network calls', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
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
    fetchMock.mockResolvedValue(jsonResponse([wikiEntry({ pageId: 'p' })]));
    const retriever = makeRetriever();

    await retriever.maybeRefresh(parts({ currentQuery: 'window A' }));
    await retriever.maybeRefresh(parts({ currentQuery: 'window A' }));

    expect(notices).toEqual(['[swarm.memory: found 1 match]']);

    fetchMock.mockResolvedValue(jsonResponse([]));
    await retriever.maybeRefresh(parts({ currentQuery: 'window B' }));
    expect(notices).toEqual([
      '[swarm.memory: found 1 match]',
      '[swarm.memory: found 0 matches]',
    ]);
  });

  it('keeps the previous cache when retrieval fails', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([wikiEntry({ pageId: 'good' })]))
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

  it('keeps the previous cache on a non-OK response', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([wikiEntry({ pageId: 'good' })]))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      } as unknown as Response);

    const retriever = makeRetriever();
    await retriever.maybeRefresh(parts({ currentQuery: 'first topic' }));

    const after = await retriever.maybeRefresh(
      parts({ currentQuery: 'different topic now' })
    );
    expect(asWiki(after[0]).pageId).toBe('good');
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
    fetchMock.mockResolvedValue(jsonResponse([]));
    const retriever = makeRetriever();

    await retriever.maybeRefresh(parts({ currentQuery: 'stable' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await retriever.forceRefresh(parts({ currentQuery: 'stable' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not call the old per-source search routes', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const retriever = makeRetriever(config(), [{ path: '/proj' }]);

    await retriever.maybeRefresh(parts({ currentQuery: 'q' }));

    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some(u => u.includes('/wiki/semantic-search'))).toBe(false);
    expect(urls.some(u => u.includes('/agents/agent-1/search'))).toBe(false);
  });
});
