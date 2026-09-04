import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSwarmPlugin } from '../../../src/plugins/swarm/index.js';
import { silentLogger } from '../../helpers.js';
import {
  createDefaultAgentConfig,
  type DroneConversationEvent,
  type DronePluginRegistration,
  type DronePromptFragment,
  type DroneToolDefinition,
} from 'drone-core';

/**
 * A minimal registration capture that collects every registered
 * onConversationEvent hook and keeps the registered prompt fragments, so a
 * test can drive the conversation pipeline by hand. Hooks are collected into
 * an array (the engine does the same) and `dispatch` invokes them in order.
 */
function createCapture(
  getConfig: () => ReturnType<typeof createDefaultAgentConfig>
) {
  const registeredFragments: DronePromptFragment[] = [];
  const conversationEventHooks: Array<
    (event: DroneConversationEvent) => Promise<void> | void
  > = [];

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig,
    registerTool: (_tool: DroneToolDefinition) => {},
    registerPromptFragment: (fragment: DronePromptFragment) => {
      registeredFragments.push(fragment);
    },
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    emitEvent: () => {},
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: cb => {
        conversationEventHooks.push(cb);
      },
      onSessionClear: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: () => undefined,
    runWorkflow: async () => ({ toolResult: undefined }),
    requestElicitation: () => undefined,
  };

  return {
    registration,
    registeredFragments,
    /** Dispatch a conversation event to every registered hook, in order. */
    dispatch: async (event: DroneConversationEvent) => {
      for (const cb of conversationEventHooks) {
        await cb(event);
      }
    },
  };
}

/** Enables swarm.memory in the agent config the plugin reads at register(). */
function memoryConfig() {
  return createDefaultAgentConfig({
    swarm: {
      memory: { enabled: true },
    },
  });
}

function searchResponse(entries: Array<Record<string, unknown>>): unknown {
  return {
    query: 'q',
    resultCount: entries.length,
    pageCount: entries.length,
    results: entries,
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe('swarm-memory retrieval trigger (userMessage)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Registers the swarm plugin and returns the captured hook + fragments. */
  async function setup(
    handler: (url: string) => unknown
  ): Promise<ReturnType<typeof createCapture>> {
    fetchMock.mockImplementation((url: string) => {
      if (url === 'http://localhost:3457/agents') {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return handler(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    const capture = createCapture(memoryConfig);
    const plugin = createSwarmPlugin({});
    await plugin.register(capture.registration);
    return capture;
  }

  /** Counts /wiki/semantic-search calls in the mock and returns their URLs. */
  function searchCalls(): string[] {
    return fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter(u => u.includes('/wiki/semantic-search'));
  }

  /** The `q` query string of a semantic-search URL (decoded from + as space). */
  function queryOf(url: string): string {
    return new URL(url).searchParams.get('q') ?? '';
  }

  it('does not retrieve before any user message', async () => {
    const capture = await setup(() => jsonResponse(searchResponse([])));

    await capture.dispatch({ kind: 'roundComplete' });

    expect(searchCalls()).toHaveLength(0);
  });

  it('triggers retrieval on userMessage and uses the current message as a query', async () => {
    const capture = await setup(() => jsonResponse(searchResponse([])));

    await capture.dispatch({
      kind: 'userMessage',
      content: 'how does the fragment ttl sweep work',
    });

    const calls = searchCalls();
    expect(calls).toHaveLength(1);
    expect(queryOf(calls[0])).toBe('how does the fragment ttl sweep work');
  });

  it('retrieves for the first message of a session even with no prior round', async () => {
    const capture = await setup(() => jsonResponse(searchResponse([])));

    await capture.dispatch({ kind: 'roundComplete' });
    await capture.dispatch({
      kind: 'userMessage',
      content: 'first question of the session',
    });

    const calls = searchCalls();
    expect(calls).toHaveLength(1);
    // The current message alone is a valid query input, so the request is
    // made even though no prior round existed (the empty-first-prompt bug).
    expect(queryOf(calls[0])).toBe('first question of the session');
  });

  it('does not trigger retrieval for assistant/tool/round events', async () => {
    const capture = await setup(() => jsonResponse(searchResponse([])));

    await capture.dispatch({
      kind: 'assistantMessage',
      content: 'an answer',
    });
    await capture.dispatch({
      kind: 'toolCall',
      name: 'file__read',
      arguments: {},
    });
    await capture.dispatch({
      kind: 'toolResult',
      name: 'file__read',
      content: '{}',
      arguments: {},
    });
    await capture.dispatch({ kind: 'roundComplete' });

    expect(searchCalls()).toHaveLength(0);
  });

  it('populates the cache and renders fragment entries once the async refresh resolves', async () => {
    const capture = await setup(() =>
      jsonResponse(
        searchResponse([
          {
            pageId: 'fragment-guide',
            title: 'Fragment Guide',
            origin: 'beacon',
            score: 0.91,
            matchedChunk:
              'The TTL sweep deletes expired fragments every minute.',
            tags: ['fragments'],
          },
        ])
      )
    );

    await capture.dispatch({
      kind: 'userMessage',
      content: 'how do fragments expire',
    });
    // The refresh is fire-and-forget; flush the async work.
    await vi.waitFor(async () => {
      expect(searchCalls()).toHaveLength(1);
    });

    const memoryFragment = capture.registeredFragments.find(
      f => f.key === 'swarm-memory'
    );
    expect(memoryFragment).toBeDefined();
    const body = await memoryFragment!.render();
    expect(body).not.toBe(false);
    expect(body as string).toContain('# Swarm Memory');
    expect(body as string).toContain('Fragment Guide');
    expect(body as string).toContain('TTL sweep');
  });
});
