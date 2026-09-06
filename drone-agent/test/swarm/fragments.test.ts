import { describe, expect, it, vi } from 'vitest';
import type { DronePluginRegistration } from 'drone-core';
import { createSwarmFragmentStore } from '../../src/plugins/swarm/fragment-store.js';
import {
  handleFragmentMessage,
  handleFragmentSyncMessage,
} from '../../src/plugins/swarm/fragment-messages.js';
import { createSwarmContext } from '../../src/plugins/swarm/context.js';
import { createSwarmPlugin } from '../../src/plugins/swarm/index.js';
import { createDefaultAgentConfig } from 'drone-core';
import { silentLogger } from '../helpers.js';
import type { DroneSwarmFragment } from 'drone-core';

function makeFragment(
  overrides: Partial<DroneSwarmFragment> = {}
): DroneSwarmFragment {
  return {
    id: 'f1',
    target: 'broadcast',
    content: 'hello',
    phase: 'header',
    scope: 'local',
    createdAt: 1,
    updatedAt: 1,
    expiresAt: null,
    ...overrides,
  };
}

describe('swarm fragment store', () => {
  it('applySet adds, updates, and detects unchanged content', () => {
    const store = createSwarmFragmentStore();
    expect(store.applySet(makeFragment())).toBe('added');
    expect(store.applySet(makeFragment({ content: 'hello world' }))).toBe(
      'updated'
    );
    expect(store.applySet(makeFragment({ content: 'hello world' }))).toBe(
      'unchanged'
    );
  });

  it('applySet same id different target are distinct rows', () => {
    const store = createSwarmFragmentStore();
    store.applySet(makeFragment({ target: 'agent-1' }));
    expect(store.applySet(makeFragment({ target: 'agent-2' }))).toBe('added');
    expect(store.size()).toBe(2);
  });

  it('applyRemove removes by id and target and reports misses', () => {
    const store = createSwarmFragmentStore();
    store.applySet(makeFragment({ target: 'agent-1' }));
    expect(store.applyRemove('f1', 'agent-1')).toBe(true);
    expect(store.applyRemove('f1', 'agent-1')).toBe(false);
    expect(store.size()).toBe(0);
  });

  it('renderHeader is false when the header bucket is empty', () => {
    const store = createSwarmFragmentStore();
    expect(store.renderHeader()).toBe(false);
    store.applySet(makeFragment({ phase: 'footer' }));
    expect(store.renderHeader()).toBe(false);
    expect(store.renderFooter()).not.toBe(false);
  });

  it('renders the documented heading and model-visible ids sorted', () => {
    const store = createSwarmFragmentStore();
    store.applySet(makeFragment({ id: 'b-second', content: 'B' }));
    store.applySet(makeFragment({ id: 'a-first', content: 'A' }));
    const header = store.renderHeader() as string;
    expect(header.startsWith('# Swarm Fragments\n\n')).toBe(true);
    expect(header).toContain('## [a-first]\n\nA');
    expect(header).toContain('## [b-second]\n\nB');
    expect(header.indexOf('## [a-first]')).toBeLessThan(
      header.indexOf('## [b-second]')
    );
  });

  it('renders footer phase under Swarm Directives', () => {
    const store = createSwarmFragmentStore();
    store.applySet(makeFragment({ id: 'd1', phase: 'footer', content: 'D' }));
    const footer = store.renderFooter() as string;
    expect(footer.startsWith('# Swarm Directives\n\n')).toBe(true);
    expect(footer).toContain('## [d1]\n\nD');
  });

  it('replaceAll replaces the full set and reports changed/unchanged', () => {
    const store = createSwarmFragmentStore();
    store.applySet(makeFragment({ id: 'old' }));
    expect(
      store.replaceAll([
        makeFragment({ id: 'new-1', content: 'n1' }),
        makeFragment({ id: 'new-2', content: 'n2' }),
      ])
    ).toBe('changed');
    expect(store.size()).toBe(2);
    expect(store.renderHeader()).not.toContain('old');
    // Identical replacement reports unchanged.
    expect(
      store.replaceAll([
        makeFragment({ id: 'new-1', content: 'n1' }),
        makeFragment({ id: 'new-2', content: 'n2' }),
      ])
    ).toBe('unchanged');
    expect(store.replaceAll([])).toBe('changed');
    expect(store.size()).toBe(0);
    expect(store.renderHeader()).toBe(false);
    expect(store.renderFooter()).toBe(false);
  });
});

describe('swarm fragment WS message handlers', () => {
  function makeCtx() {
    const notices: string[] = [];
    const emitEvent = vi.fn((event: { kind: string; content?: string }) => {
      if (event.kind === 'notice' && event.content) {
        notices.push(event.content);
      }
    });
    const registration = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      request: vi.fn((id: string) =>
        id === '_runtime' ? { emitEvent } : undefined
      ),
    } as unknown as DronePluginRegistration;
    const ctx = createSwarmContext(
      'http://beacon.test',
      'agent-1',
      registration,
      'ws://beacon.test/ws'
    );
    return { ctx, emitEvent, notices };
  }

  it('fragment set emits one notice with id and applied change', () => {
    const { ctx, emitEvent } = makeCtx();
    handleFragmentMessage(ctx, {
      op: 'set',
      fragment: makeFragment({ id: 'n1' }),
    });
    expect(ctx.fragmentStore.size()).toBe(1);
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent.mock.calls[0][0]).toEqual({
      kind: 'notice',
      content: 'Swarm fragment added: n1',
    });
  });

  it('fragment remove emits a notice only when the row existed', () => {
    const { ctx, emitEvent } = makeCtx();
    handleFragmentMessage(ctx, {
      op: 'remove',
      fragment: makeFragment({ id: 'missing' }),
    });
    expect(emitEvent).not.toHaveBeenCalled();
    ctx.fragmentStore.applySet(makeFragment({ id: 'present' }));
    handleFragmentMessage(ctx, {
      op: 'remove',
      fragment: makeFragment({ id: 'present' }),
    });
    expect(ctx.fragmentStore.size()).toBe(0);
    expect(emitEvent).toHaveBeenCalledWith({
      kind: 'notice',
      content: 'Swarm fragment removed: present',
    });
  });

  it('fragmentSync replaces the set and suppresses the notice on the initial resync only', () => {
    const { ctx, emitEvent } = makeCtx();
    handleFragmentSyncMessage(ctx, {
      fragments: [makeFragment({ id: 's1', content: 'v1' })],
    });
    // Initial resync is silent even though content changed.
    expect(emitEvent).not.toHaveBeenCalled();
    expect(ctx.fragmentsResynced).toBe(true);
    // A later resync that changes content emits one summary notice.
    handleFragmentSyncMessage(ctx, {
      fragments: [makeFragment({ id: 's1', content: 'v2' })],
    });
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent.mock.calls[0][0]).toEqual({
      kind: 'notice',
      content: 'Swarm fragments resynced (1 active)',
    });
    // An identical resync emits nothing.
    handleFragmentSyncMessage(ctx, {
      fragments: [makeFragment({ id: 's1', content: 'v2' })],
    });
    expect(emitEvent).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed payloads without throwing', () => {
    const { ctx, emitEvent } = makeCtx();
    expect(() => handleFragmentMessage(ctx, {})).not.toThrow();
    expect(() => handleFragmentSyncMessage(ctx, {})).not.toThrow();
    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe('swarm plugin fragment registration', () => {
  function makeRegistrationCapture() {
    const promptFragments: Array<{
      key: string;
      phase: 'header' | 'footer';
      render: () => Promise<string | false>;
    }> = [];
    const registration: DronePluginRegistration = {
      logger: silentLogger(),
      getConfig: () =>
        createDefaultAgentConfig({ swarm: { beaconPort: 3457 } }),
      registerTool: () => {},
      registerPromptFragment: fragment => {
        promptFragments.push(fragment as (typeof promptFragments)[number]);
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
        onConversationEvent: () => {},
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
    return { registration, promptFragments };
  }

  it('registers the two fragment prompt seams at registration time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    );
    try {
      const { registration, promptFragments } = makeRegistrationCapture();
      const plugin = createSwarmPlugin({});
      await plugin.register(registration);

      const headerPrompt = promptFragments.find(f => f.phase === 'header');
      const footerPrompt = promptFragments.find(f => f.phase === 'footer');
      expect(headerPrompt).toBeDefined();
      expect(footerPrompt).toBeDefined();
      expect(headerPrompt?.key).toBe('fragments.header');
      expect(footerPrompt?.key).toBe('fragments.footer');

      // Renders return false on an empty store even while the WS is fake.
      await expect(headerPrompt?.render()).resolves.toBe(false);
      await expect(footerPrompt?.render()).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
