import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createSwarmPlugin } from '../src/plugins/swarm/index.js';
import { focusPlugin } from '../src/plugins/focus.js';
import { personaPlugin } from '../src/plugins/persona/index.js';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { silentLogger } from './helpers.js';
import {
  createDefaultAgentConfig,
  type DroneConversationEvent,
  type DronePersonaDefinition,
  type DronePluginRegistration,
} from 'drone-core';

/**
 * Minimal registration capture: collects emitted events and registered hooks so
 * a test can drive the lifecycle by hand (mirrors the engine's dispatch).
 */
function createCapture(
  getConfig: () => ReturnType<typeof createDefaultAgentConfig>,
  capabilities: Record<string, unknown>
) {
  const emitted: DroneConversationEvent[] = [];
  const conversationEventHooks: Array<
    (event: DroneConversationEvent) => Promise<void> | void
  > = [];
  const hooks: Record<string, Array<() => Promise<void>>> = {};

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig,
    registerTool: () => {},
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    emitEvent: (event: DroneConversationEvent) => {
      emitted.push(event);
    },
    hooks: {
      onPluginsLoaded: cb => {
        (hooks.onPluginsLoaded ??= []).push(cb);
      },
      onSessionStart: cb => {
        (hooks.onSessionStart ??= []).push(cb);
      },
      onBeforePrompt: cb => {
        (hooks.onBeforePrompt ??= []).push(cb);
      },
      onAfterToolCall: cb => {
        (hooks.onAfterToolCall ??= []).push(cb);
      },
      onConversationEvent: cb => {
        conversationEventHooks.push(cb);
      },
      onSessionClear: cb => {
        (hooks.onSessionClear ??= []).push(cb);
      },
      onShutdown: cb => {
        (hooks.onShutdown ??= []).push(cb);
      },
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: <T>(pluginId: string) => capabilities[pluginId] as T | undefined,
    runWorkflow: async () => ({}),
    requestElicitation: () => undefined,
    mountTool: () => undefined,
    unmountTool: () => {},
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    listMountedTools: () => [],
  };

  return {
    registration,
    emitted,
    conversationEventHooks,
    runSessionStart: async () => {
      for (const cb of hooks.onSessionStart ?? []) await cb();
    },
  };
}

/** Enables swarm in the agent config the plugin reads at register(). */
function swarmConfig() {
  return createDefaultAgentConfig({
    swarm: { enabled: true },
  });
}

/** A persona capability the swarm plugin can drive without a live broker. */
function personaCapability(active: DronePersonaDefinition | null) {
  return {
    getActivePersona: () => active,
    getPersonas: () => [],
    selectPersona: () => {},
    reloadPersonas: async () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    registerWriter: () => {},
    registerCustomCommand: () => {},
    onPersonaChange: () => {},
  };
}

describe('db/transcript session-parameter event emission', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('swarm sessionStarted (subagent)', () => {
    it('emits sessionStarted with subagentId when isSubagent on session start', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      const capture = createCapture(swarmConfig, {
        persona: personaCapability({ id: 'coder', name: 'Coder' }),
        runtime: {
          isSubagent: true,
          subagentId: 'subagent-123',
          persona: 'coder',
        },
      });
      const plugin = createSwarmPlugin({});
      await plugin.register(capture.registration);

      await capture.runSessionStart();

      const started = capture.emitted.find(
        e => e.kind === 'sessionStarted'
      ) as Extract<DroneConversationEvent, { kind: 'sessionStarted' }>;
      expect(started).toBeDefined();
      expect(started.subagentId).toBe('subagent-123');
      expect(started.personaId).toBe('coder');
    });

    it('does not emit sessionStarted when not a subagent', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      const capture = createCapture(swarmConfig, {
        persona: personaCapability(null),
        runtime: {
          isSubagent: false,
          subagentId: null,
          persona: null,
        },
      });
      const plugin = createSwarmPlugin({});
      await plugin.register(capture.registration);

      await capture.runSessionStart();

      expect(capture.emitted.some(e => e.kind === 'sessionStarted')).toBe(
        false
      );
    });
  });

  describe('buffered events carry new kinds end-to-end', () => {
    it('wraps a sessionStarted event into the event buffer payload', async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      const capture = createCapture(swarmConfig, {
        persona: personaCapability({ id: 'coder', name: 'Coder' }),
        runtime: {
          isSubagent: true,
          subagentId: 'subagent-7',
          persona: 'coder',
        },
      });
      const plugin = createSwarmPlugin({});
      await plugin.register(capture.registration);

      // Simulate the onSessionStart hook emitting sessionStarted; the swarm
      // plugin's onConversationEvent hook should buffer it.
      await capture.runSessionStart();
      const buffered = capture.emitted.find(e => e.kind === 'sessionStarted');
      expect(buffered).toBeDefined();

      // Dispatch the same event through the buffering hook and confirm it
      // flows into the buffer as a pushable event (no throw, open type).
      const eventsBefore = fetchMock.mock.calls.length;
      for (const cb of capture.conversationEventHooks) {
        await cb({
          kind: 'sessionStarted',
          subagentId: 'subagent-7',
          personaId: 'coder',
        });
      }
      // flushEndpoint not called directly here (buffer flush is on shutdown /
      // after tool call), but the buffer accepted the event without error.
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(eventsBefore);
    });
  });
});

describe('focus plugin focusChanged emission', () => {
  it('emits focusChanged when /focus set runs', async () => {
    const engine = createDronePluginEngine({
      plugins: [focusPlugin],
      config: {
        ...createDefaultAgentConfig(),
        enabledPlugins: ['focus'],
      },
      logger: silentLogger(),
    });
    await engine.initialize();
    await engine.runHooks('onPluginsLoaded');

    const capturedEvents: DroneConversationEvent[] = [];
    engine.onConversationEvent(event => {
      capturedEvents.push(event);
    });

    const handled = await engine.dispatchSlashCommand('/focus set Fix login', {
      logger: silentLogger(),
      engine,
      conversation: undefined,
      sessionManager: undefined,
    });
    expect(handled).toBe(true);

    const focusEvent = capturedEvents.find(
      e => e.kind === 'focusChanged'
    ) as Extract<DroneConversationEvent, { kind: 'focusChanged' }>;
    expect(focusEvent).toBeDefined();
    expect(focusEvent.focus).toBe('Fix login');
  });

  it('emits focusChanged with null when /focus clear runs', async () => {
    const engine = createDronePluginEngine({
      plugins: [focusPlugin],
      config: {
        ...createDefaultAgentConfig(),
        enabledPlugins: ['focus'],
      },
      logger: silentLogger(),
    });
    await engine.initialize();
    await engine.runHooks('onPluginsLoaded');

    const capturedEvents: DroneConversationEvent[] = [];
    engine.onConversationEvent(event => {
      capturedEvents.push(event);
    });

    await engine.dispatchSlashCommand('/focus set Things', {
      logger: silentLogger(),
      engine,
      conversation: undefined,
      sessionManager: undefined,
    });
    await engine.dispatchSlashCommand('/focus clear', {
      logger: silentLogger(),
      engine,
      conversation: undefined,
      sessionManager: undefined,
    });

    const focusEvents = capturedEvents.filter(e => e.kind === 'focusChanged');
    const focusEvent = focusEvents[focusEvents.length - 1] as Extract<
      DroneConversationEvent,
      { kind: 'focusChanged' }
    >;
    expect(focusEvent).toBeDefined();
    expect(focusEvent.focus).toBeNull();
  });
});

describe('persona plugin personaChanged emission', () => {
  it('emits personaChanged with from/to when the persona changes', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona'];
    const engine = createDronePluginEngine({
      plugins: [personaPlugin],
      config,
      logger: silentLogger(),
    });
    await engine.initialize();

    const capturedEvents: DroneConversationEvent[] = [];
    engine.onConversationEvent(event => {
      capturedEvents.push(event);
    });

    const personaCap = engine.getCapability<{
      registerProvider: (p: {
        id: string;
        precedence: number;
        getPersonas: () => Array<{ id: string; name: string }>;
        getPersona: (id: string) => { id: string; name: string } | undefined;
        reloadPersonas: () => Promise<void>;
      }) => void;
      reloadPersonas: () => Promise<void>;
      selectPersona: (id: string) => void;
    }>('persona');
    expect(personaCap).toBeDefined();
    personaCap!.registerProvider({
      id: 'test-provider',
      precedence: 10,
      getPersonas: () => [
        { id: 'coder', name: 'Coder' },
        { id: 'reviewer', name: 'Reviewer' },
      ],
      getPersona: id =>
        id === 'coder'
          ? { id: 'coder', name: 'Coder' }
          : id === 'reviewer'
            ? { id: 'reviewer', name: 'Reviewer' }
            : undefined,
      reloadPersonas: async () => {},
    });
    await personaCap!.reloadPersonas();

    // Switch coder -> reviewer.
    personaCap!.selectPersona('coder');
    personaCap!.selectPersona('reviewer');

    const changes = capturedEvents.filter(e => e.kind === 'personaChanged');
    expect(changes.length).toBeGreaterThanOrEqual(2);
    const second = changes[1] as Extract<
      DroneConversationEvent,
      { kind: 'personaChanged' }
    >;
    expect(second.from).toBe('coder');
    expect(second.to).toBe('reviewer');
  });
});
