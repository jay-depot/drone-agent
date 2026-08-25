import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DronePluginRegistration } from 'drone-core';
import { createWikiTools } from '../src/plugins/swarm/tools-wiki.js';
import { createCoordinatorTools } from '../src/plugins/swarm/tools-coordinator.js';
import { createSwarmMessageTool } from '../src/plugins/swarm/tools-message.js';
import { createSwarmContext } from '../src/plugins/swarm/context.js';

/**
 * Minimal registration stand-in: the validation guards under test run
 * before anything dereferences registration members.
 */
const registration = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
} as unknown as DronePluginRegistration;

function wikiToolMap(
  ctx = createSwarmContext(
    'http://beacon.test',
    's1',
    registration,
    'ws://beacon.test'
  )
) {
  return new Map(createWikiTools(ctx).map(t => [t.name, t]));
}

function coordinatorToolMap() {
  return new Map(
    createCoordinatorTools('http://coordinator.test').map(t => [t.name, t])
  );
}

async function expectRejection(
  resultPromise: Promise<string>,
  expectedFragment: RegExp
) {
  const parsed = JSON.parse(await resultPromise);
  expect(parsed.success).toBe(false);
  expect(parsed.error).toMatch(expectedFragment);
}

describe('swarm tool input validation (pre-network guards)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ['wiki_read', {}, 'pageId'],
    ['wiki_read', { pageId: '   ' }, 'pageId'],
    ['wiki_search', {}, 'query'],
    ['wiki_delete', {}, 'pageId'],
    ['wiki_write', { title: 'T', content: 'C' }, 'pageId'],
    ['wiki_write', { pageId: 'p' }, 'title'],
    ['wiki_write', {}, 'pageId'],
  ])('%s rejects missing/empty %j input', async (name, input, field) => {
    const tools = wikiToolMap();
    await expectRejection(
      tools.get(name)!.execute(input),
      new RegExp(`${name} requires a non-empty ${field}`)
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['swarm_spawn', {}, 'targetBeaconId'],
    ['swarm_get_spawn', { beaconId: 'b' }, 'spawnId'],
    ['swarm_get_spawn', {}, 'beaconId'],
    ['swarm_list_spawns', {}, 'beaconId'],
    ['swarm_terminate_spawn', { beaconId: 'b' }, 'spawnId'],
    ['swarm_terminate_spawn', {}, 'beaconId'],
  ])('%s rejects missing/empty %j input', async (name, input, field) => {
    const tools = coordinatorToolMap();
    await expectRejection(
      tools.get(name)!.execute(input),
      new RegExp(`${name} requires a non-empty ${field}`)
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wiki_read still performs the network call for valid input', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'real-page' }),
    });
    const tools = wikiToolMap();
    const parsed = JSON.parse(
      await tools.get('wiki_read')!.execute({ pageId: 'real-page' })
    );
    expect(parsed.success).toBe(true);
    expect(parsed.page.id).toBe('real-page');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/wiki/real-page');
  });

  it('swarm_message send requires a non-empty body', async () => {
    const ctx = createSwarmContext(
      'http://beacon.test',
      's1',
      registration,
      'ws://beacon.test'
    );
    const tool = createSwarmMessageTool(ctx);

    await expectRejection(
      tool.execute({ action: 'send', toAgentId: 'agent-2' }),
      /send requires a non-empty body/
    );
    await expectRejection(
      tool.execute({ action: 'send', toAgentId: 'agent-2', body: '' }),
      /send requires a non-empty body/
    );
  });
});
