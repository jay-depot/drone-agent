import { describe, expect, it, vi } from 'vitest';

import { createSwarmMemoryFragment } from '../../../src/plugins/swarm/memory-fragment.js';
import { SwarmMemoryRetriever } from '../../../src/plugins/swarm/memory-retrieval.js';
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

async function render(
  retriever: SwarmMemoryRetriever
): Promise<string | false> {
  const fragment = createSwarmMemoryFragment(retriever);
  return fragment.render();
}

describe('swarm-memory prompt fragment', () => {
  it('hides (false) when disabled, even with a populated cache', async () => {
    const retriever = new SwarmMemoryRetriever({
      capability,
      config: { ...baseConfig(), enabled: false },
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    retriever.setCacheForTest([
      {
        pageId: 'p',
        origin: 'beacon',
        title: 'T',
        tags: [],
        score: 0.9,
        pitch: 'p',
      },
    ]);
    expect(await render(retriever)).toBe(false);
  });

  it('hides (false) while enabled but nothing has been retrieved yet', async () => {
    const retriever = new SwarmMemoryRetriever({
      capability,
      config: baseConfig(),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    expect(await render(retriever)).toBe(false);
  });

  it('renders the advertise+recall index with framing and recall instructions', async () => {
    const retriever = new SwarmMemoryRetriever({
      capability,
      config: baseConfig(),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    retriever.setCacheForTest([
      {
        pageId: 'fragment-guide',
        origin: 'coordinator',
        title: 'Fragment Guide',
        tags: [],
        score: 0.91,
        pitch: 'The TTL sweep deletes expired fragments every minute.',
      },
    ]);
    const text = await render(retriever);
    expect(text).not.toBe(false);
    const body = text as string;
    expect(body).toContain('# Swarm Memory (wiki)');
    expect(body).toContain('reference data');
    expect(body).toContain('not instructions');
    expect(body).toContain('wiki_read');
    expect(body).toContain('fragment-guide');
    expect(body).toContain('(coordinator)');
    expect(body).toContain('score 0.91');
    expect(body).toContain('The TTL sweep deletes expired fragments');
  });

  it('caps the pitch to one line at ~240 chars with an ellipsis', async () => {
    const retriever = new SwarmMemoryRetriever({
      capability,
      config: baseConfig(),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    retriever.setCacheForTest([
      {
        pageId: 'p',
        origin: 'beacon',
        title: 'T',
        tags: [],
        score: 1,
        pitch: `start ${'x'.repeat(400)}`,
      },
    ]);
    const body = (await render(retriever)) as string;
    const bullet = body.split('\n').find(l => l.startsWith('- ')) ?? '';
    expect(bullet.length).toBeLessThan(320);
    expect(bullet).toContain('…');
    expect(bullet.split('\n')).toHaveLength(1);
  });
});
