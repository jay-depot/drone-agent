import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toToolResultContent, type DronePluginRegistration } from 'drone-core';
import { createWikiTools } from '../../src/plugins/swarm/tools-wiki.js';
import { createSwarmContext } from '../../src/plugins/swarm/context.js';

const registration = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as DronePluginRegistration;

function editTool() {
  const ctx = createSwarmContext(
    'http://beacon.test',
    's1',
    registration,
    'ws://beacon.test',
    'localhost:3457'
  );
  const tool = createWikiTools(ctx).find(t => t.name === 'wiki_edit');
  if (!tool) throw new Error('wiki_edit tool not registered');
  return tool;
}

async function run(input: Record<string, unknown>) {
  return JSON.parse(toToolResultContent(await editTool().execute(input)));
}

interface MockPage {
  content?: string;
  title?: string;
  tags?: string[];
  sources?: string[];
  pitch?: string;
}

function readResponse(page: MockPage, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => page,
  };
}

function putResponse(page: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => page,
  };
}

describe('swarm wiki_edit', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects when pageId is missing', async () => {
    const parsed = await run({ diff: '-a\n+b' });
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/at least one change/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when neither diff nor a metadata field is provided', async () => {
    const parsed = await run({ pageId: 'p' });
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/at least one change/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies a diff-only edit and carries metadata from the read', async () => {
    const page: MockPage = {
      content: 'line1\nline2\nline3',
      title: 'Old Title',
      tags: ['a'],
      sources: ['s1'],
      pitch: 'A pitch.',
    };
    fetchMock
      .mockResolvedValueOnce(readResponse(page))
      .mockResolvedValueOnce(putResponse({ id: 'p', ...page }));

    const parsed = await run({
      pageId: 'p',
      diff: [' line1', '-line2', '+line2_modified', ' line3'].join('\n'),
    });

    expect(parsed.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [readUrl] = fetchMock.mock.calls[0] as [string];
    expect(String(readUrl)).toContain('/wiki/p?scope=beacon');
    const [putUrl, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(putUrl)).toContain('/wiki/p');
    expect(putInit.method).toBe('PUT');
    const body = JSON.parse(String(putInit.body));
    expect(body.content).toBe('line1\nline2_modified\nline3');
    expect(body.title).toBe('Old Title');
    expect(body.tags).toEqual(['a']);
    expect(body.sources).toEqual(['s1']);
    expect(body.pitch).toBe('A pitch.');
  });

  it('applies a metadata-only edit without changing the body', async () => {
    const page: MockPage = { content: 'Body.', title: 'Old' };
    fetchMock
      .mockResolvedValueOnce(readResponse(page))
      .mockResolvedValueOnce(putResponse({ id: 'p' }));

    const parsed = await run({ pageId: 'p', title: 'New Title' });

    expect(parsed.success).toBe(true);
    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(putInit.body));
    expect(body.title).toBe('New Title');
    expect(body.content).toBe('Body.');
  });

  it('overrides title/tags/pitch when supplied', async () => {
    const page: MockPage = {
      content: 'Body.',
      title: 'Old',
      tags: ['a'],
      pitch: 'Old pitch.',
    };
    fetchMock
      .mockResolvedValueOnce(readResponse(page))
      .mockResolvedValueOnce(putResponse({ id: 'p' }));

    const parsed = await run({
      pageId: 'p',
      title: 'New',
      tags: ['b', 'c'],
      pitch: 'New pitch.',
    });

    expect(parsed.success).toBe(true);
    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(putInit.body));
    expect(body.title).toBe('New');
    expect(body.tags).toEqual(['b', 'c']);
    expect(body.pitch).toBe('New pitch.');
  });

  it('carries the existing pitch through when omitted', async () => {
    const page: MockPage = { content: 'line1\nline2', pitch: 'Carried.' };
    fetchMock
      .mockResolvedValueOnce(readResponse(page))
      .mockResolvedValueOnce(putResponse({ id: 'p' }));

    const parsed = await run({
      pageId: 'p',
      diff: [' line1', '-line2', '+line2b'].join('\n'),
    });

    expect(parsed.success).toBe(true);
    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(putInit.body));
    expect(body.pitch).toBe('Carried.');
  });

  it('surfaces a read 404 without issuing a PUT', async () => {
    fetchMock.mockResolvedValueOnce(readResponse({}, false, 404));

    const parsed = await run({ pageId: 'missing', diff: '-a\n+b' });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('Wiki page not found: missing (scope: beacon)');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a beacon error when the PUT fails', async () => {
    fetchMock
      .mockResolvedValueOnce(readResponse({ content: 'Body.' }))
      .mockResolvedValueOnce(
        putResponse({ error: 'beacon exploded' }, false, 500)
      );

    const parsed = await run({ pageId: 'p', title: 'New' });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('beacon exploded');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('PUTs the partial result and surfaces failures on partial success', async () => {
    const page: MockPage = { content: 'good\nold\n' };
    fetchMock
      .mockResolvedValueOnce(readResponse(page))
      .mockResolvedValueOnce(putResponse({ id: 'p' }));

    const parsed = await run({
      pageId: 'p',
      diff: [
        '@@ -1,2 +1,2 @@',
        ' good',
        '-old',
        '+new',
        '@@ -99,1 +99,1 @@',
        '-nonexistent_line',
        '+other',
      ].join('\n'),
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/failed to apply/);
    // The partial result must still have been written.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(putInit.body));
    expect(body.content).toContain('new');
  });

  it('appends via a pure-insertion diff anchored by one context line', async () => {
    const page: MockPage = { content: 'a\nb' };
    fetchMock
      .mockResolvedValueOnce(readResponse(page))
      .mockResolvedValueOnce(putResponse({ id: 'p' }));

    const parsed = await run({
      pageId: 'p',
      diff: [' b', '+appended'].join('\n'),
    });

    expect(parsed.success).toBe(true);
    const [, putInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(String(putInit.body));
    expect(body.content).toContain('appended');
  });
});
