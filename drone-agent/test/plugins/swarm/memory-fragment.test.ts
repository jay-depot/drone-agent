import { describe, expect, it, vi } from 'vitest';

import { createSwarmMemoryFragment } from '../../../src/plugins/swarm/memory-fragment.js';
import {
  SwarmMemoryRetriever,
  type SwarmMemoryEntry,
} from '../../../src/plugins/swarm/memory-retrieval.js';
import type { DroneSwarmCapability, DroneSwarmMemoryConfig } from 'drone-core';

const capability: DroneSwarmCapability = {
  getBeaconUrl: () => 'http://beacon:3457',
  getAgentId: () => 'agent-1',
};

function baseConfig(enabled = true): DroneSwarmMemoryConfig {
  return {
    enabled,
    topK: 5,
    minScore: 0.35,
    anchors: { tags: [], boostPerTag: 0.08, boostTitle: 0.05 },
    window: { maxQueryTokens: 6000, maxQuerySegments: 3 },
  };
}

function wikiEntry(
  overrides: Partial<Extract<SwarmMemoryEntry, { kind: 'wiki' }>> = {}
) {
  return {
    kind: 'wiki' as const,
    pageId: 'p',
    origin: 'beacon' as const,
    title: 'T',
    tags: [],
    score: 0.9,
    pitch: 'p',
    ...overrides,
  };
}

function fileEntry(
  overrides: Partial<Extract<SwarmMemoryEntry, { kind: 'file' }>> = {}
) {
  return {
    kind: 'file' as const,
    filePath: '/proj/a.ts',
    score: 0.8,
    snippet: 's',
    ...overrides,
  };
}

async function render(
  retriever: SwarmMemoryRetriever
): Promise<string | false> {
  const fragment = createSwarmMemoryFragment(retriever);
  return fragment.render();
}

function makeRetriever(enabled = true): SwarmMemoryRetriever {
  return new SwarmMemoryRetriever({
    capability,
    config: baseConfig(enabled),
    logger: { warn: vi.fn(), info: vi.fn() },
  });
}

describe('swarm-memory prompt fragment', () => {
  it('hides (false) when disabled, even with a populated cache', async () => {
    const retriever = new SwarmMemoryRetriever({
      capability,
      config: { ...baseConfig(), enabled: false },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    retriever.setCacheForTest([wikiEntry({ pitch: 'p' })]);
    expect(await render(retriever)).toBe(false);
  });

  it('hides (false) while enabled but nothing has been retrieved yet', async () => {
    const retriever = makeRetriever();
    expect(await render(retriever)).toBe(false);
  });

  it('renders the advertise+recall index with framing and recall instructions', async () => {
    const retriever = makeRetriever();
    retriever.setCacheForTest([
      wikiEntry({
        pageId: 'fragment-guide',
        origin: 'coordinator',
        title: 'Fragment Guide',
        score: 0.91,
        pitch: 'The TTL sweep deletes expired fragments every minute.',
      }),
    ]);
    const text = await render(retriever);
    expect(text).not.toBe(false);
    const body = text as string;
    expect(body).toContain('# Swarm Memory');
    expect(body).toContain('may be relevant to this conversation');
    expect(body).toContain('wiki_read');
    expect(body).toContain('fragment-guide');
    expect(body).toContain('(coordinator)');
    expect(body).toContain('score: 0.91');
    expect(body).toContain('The TTL sweep deletes expired fragments');
    expect(body).toContain('- wiki `fragment-guide`');
  });

  it('renders the stored pitch unchanged from the entry', async () => {
    const retriever = makeRetriever();
    retriever.setCacheForTest([
      wikiEntry({
        pageId: 'pitch-page',
        origin: 'coordinator',
        title: 'Pitch Page',
        score: 0.85,
        pitch: 'A concise stored one-sentence pitch.',
      }),
    ]);
    const text = await render(retriever);
    expect(text).not.toBe(false);
    const body = text as string;
    expect(body).toContain('pitch-page');
    expect(body).toContain('A concise stored one-sentence pitch.');
  });

  it('caps the pitch to one line at ~400 chars with an ellipsis', async () => {
    const retriever = makeRetriever();
    retriever.setCacheForTest([
      wikiEntry({ score: 1, pitch: `start ${'x'.repeat(400)}` }),
    ]);
    const body = (await render(retriever)) as string;
    const bullet = body.split('\n').find(l => l.startsWith('- ')) ?? '';
    expect(bullet.length).toBeLessThan(500);
    expect(bullet).toContain('…');
    expect(bullet.split('\n')).toHaveLength(1);
  });

  it('renders a file entry with its absolute path and snippet', async () => {
    const retriever = makeRetriever();
    retriever.setCacheForTest([
      fileEntry({
        filePath: '/proj/src/runtime/config.ts',
        score: 0.77,
        snippet: 'The config loader walks up the directory tree.',
      }),
    ]);
    const body = (await render(retriever)) as string;
    expect(body).toContain('- file `/proj/src/runtime/config.ts`');
    expect(body).toContain('score: 0.77');
    expect(body).toContain('The config loader walks up the directory tree.');
  });

  it('names both recall tools when both kinds are present', async () => {
    const retriever = makeRetriever();
    retriever.setCacheForTest([
      wikiEntry({ pageId: 'w', pitch: 'wiki pitch' }),
      fileEntry({ filePath: '/proj/f.ts', snippet: 'file snippet' }),
    ]);
    const body = (await render(retriever)) as string;
    expect(body).toContain('swarm__wiki_read');
    expect(body).toContain('file__read');
    expect(body).toContain('- wiki `w`');
    expect(body).toContain('- file `/proj/f.ts`');
  });
});
