import { describe, expect, it, vi } from 'vitest';
import type { DroneSwarmCapability, DroneSwarmMemoryConfig } from 'drone-core';

import { createSwarmMemoryCommand } from '../../../src/plugins/swarm/slash-swarm-memory.js';
import { SwarmMemoryRetriever } from '../../../src/plugins/swarm/memory-retrieval.js';

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

function makeCtx(args: string[], info: string[]) {
  return {
    args,
    logger: {
      info: (m: string) => info.push(m),
      warn: () => {},
      error: () => {},
    },
  } as never;
}

describe('/swarm-memory slash command', () => {
  it('status reports OFF with the suppression reason', async () => {
    const retriever = new SwarmMemoryRetriever({
      capability,
      config: baseConfig(false),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const command = createSwarmMemoryCommand(retriever);
    const info: string[] = [];
    await command.handler(makeCtx(['status'], info));
    expect(info.join('\n')).toContain('OFF');
    expect(info.join('\n')).toContain('disabled in config');
  });

  it('status reports cached entries after a retrieval', async () => {
    const retriever = new SwarmMemoryRetriever({
      capability,
      config: baseConfig(),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    retriever.setCacheForTest([
      {
        pageId: 'p1',
        origin: 'beacon',
        title: 'Page One',
        tags: [],
        score: 0.87,
        pitch: 'pitch',
      },
    ]);
    const command = createSwarmMemoryCommand(retriever);
    const info: string[] = [];
    await command.handler(makeCtx(['status'], info));
    const report = info.join('\n');
    expect(report).toContain('ON');
    expect(report).toContain('p1');
    expect(report).toContain('1 entries');
  });

  it('session-scope off suppresses; on re-enables', async () => {
    const retriever = new SwarmMemoryRetriever({
      capability,
      config: baseConfig(),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const command = createSwarmMemoryCommand(retriever);
    const info: string[] = [];

    await command.handler(makeCtx(['session-scope', 'off'], info));
    expect(retriever.isSessionEnabled()).toBe(false);
    expect(info.join('\n')).toContain('suppressed');

    await command.handler(makeCtx(['session-scope', 'on'], info));
    expect(retriever.isSessionEnabled()).toBe(true);
    expect(info.join('\n')).toContain('re-enabled');
  });

  it('refresh delegates to the injected callback and reports the count', async () => {
    const retriever = new SwarmMemoryRetriever({
      capability,
      config: baseConfig(),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    retriever.setWindowSource(() => ({
      currentQuery: 'q',
      prevUserQuery: '',
      prevSteering: [],
      prevResponse: '',
    }));
    const command = createSwarmMemoryCommand(retriever);
    const info: string[] = [];
    await command.handler(makeCtx(['refresh'], info));
    expect(info.join('\n')).toContain('Refresh complete');
    expect(info.join('\n')).toContain('0 entries');
  });

  it('unknown subcommand prints usage', async () => {
    const retriever = new SwarmMemoryRetriever({
      capability,
      config: baseConfig(),
      logger: { warn: vi.fn(), info: vi.fn() },
    });
    const command = createSwarmMemoryCommand(retriever);
    const info: string[] = [];
    await command.handler(makeCtx(['bogus'], info));
    expect(info.join('\n')).toContain('Usage:');
  });
});
