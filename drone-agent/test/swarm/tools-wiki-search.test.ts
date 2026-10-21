import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toToolResultContent, type DronePluginRegistration } from 'drone-core';
import { createWikiTools } from '../../src/plugins/swarm/tools-wiki.js';
import { createSwarmContext } from '../../src/plugins/swarm/context.js';

const registration = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as DronePluginRegistration;

function searchTool() {
  const ctx = createSwarmContext(
    'http://beacon.test',
    's1',
    registration,
    'ws://beacon.test',
    'localhost:3457'
  );
  const tool = createWikiTools(ctx).find(t => t.name === 'wiki_search');
  if (!tool) throw new Error('wiki_search tool not registered');
  return tool;
}

async function run(input: Record<string, unknown>) {
  return JSON.parse(toToolResultContent(await searchTool().execute(input)));
}

describe('swarm wiki_search (semantic)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queries the semantic endpoint, not the keyword one', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ resultCount: 0, results: [] }),
    });

    await run({ query: 'how does reindex work' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/wiki/semantic-search');
    expect(url).not.toContain('/wiki/search');
  });

  it('passes a natural-language query through intact', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ resultCount: 0, results: [] }),
    });

    await run({ query: 'what are the two embedding bugs?' });

    const url = String(fetchMock.mock.calls[0][0]);
    // URLSearchParams encodes spaces as '+' and '?' as %3F; assert the value
    // survives round-tripping rather than pinning one valid encoding.
    expect(new URL(url).searchParams.get('q')).toBe(
      'what are the two embedding bugs?'
    );
  });

  it('forwards maxResults and minScore when supplied', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ resultCount: 0, results: [] }),
    });

    await run({ query: 'q', maxResults: 3, minScore: 0.42 });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('maxResults=3');
    expect(url).toContain('minScore=0.42');
  });

  it('omits maxResults/minScore when not supplied', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({ resultCount: 0, results: [] }),
    });

    await run({ query: 'q' });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).not.toContain('maxResults');
    expect(url).not.toContain('minScore');
  });

  it('returns the semantic result payload on success', async () => {
    const payload = {
      query: 'q',
      resultCount: 1,
      pageCount: 1,
      results: [
        {
          pageId: 'some-page',
          origin: 'coordinator',
          title: 'Some Page',
          tags: ['x'],
          score: 0.81,
          matchedChunk: 'text',
        },
      ],
    };
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => payload,
    });

    const parsed = await run({ query: 'q' });

    expect(parsed.success).toBe(true);
    expect(parsed.results.resultCount).toBe(1);
    expect(parsed.results.results[0].pageId).toBe('some-page');
  });

  it('explains a 503 (no embedding provider) instead of a bare failure', async () => {
    fetchMock.mockResolvedValue({
      status: 503,
      ok: false,
      json: async () => ({ error: 'No embedding provider available' }),
    });

    const parsed = await run({ query: 'q' });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/no embedding provider/i);
    expect(parsed.error).toMatch(/wiki_list/);
  });

  it('surfaces the status code on other HTTP failures', async () => {
    fetchMock.mockResolvedValue({
      status: 500,
      ok: false,
      json: async () => ({}),
    });

    const parsed = await run({ query: 'q' });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('500');
  });

  it('reports a network error without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const parsed = await run({ query: 'q' });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('ECONNREFUSED');
  });

  it('rejects an empty query before any network call', async () => {
    const parsed = await run({ query: '   ' });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/wiki_search requires a non-empty query/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
