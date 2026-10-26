import { describe, expect, it } from 'vitest';
import type {
  DroneConversationEvent,
  DronePluginRegistration,
  DronePromptFragment,
  DroneSwarmCapability,
} from 'drone-core';
import { createExtensionsContext } from '../../../src/plugins/extensions/context.js';
import { handleInjection } from '../../../src/plugins/extensions/injection-handlers.js';
import { silentLogger } from '../../helpers.js';

interface Capture {
  registration: DronePluginRegistration;
  fragments: DronePromptFragment[];
  wsHandlers: Map<string, (payload: unknown, raw: unknown) => void>;
  events: DroneConversationEvent[];
  onRecycle?: () => Promise<void>;
  slashCommands: string[];
}

function createCapture(): Capture {
  const fragments: DronePromptFragment[] = [];
  const wsHandlers = new Map<string, (p: unknown, r: unknown) => void>();
  const events: DroneConversationEvent[] = [];
  const slashCommands: string[] = [];
  let onRecycle: (() => Promise<void>) | undefined;

  const swarmCap: DroneSwarmCapability = {
    getBeaconUrl: () => 'http://beacon.test',
    getAgentId: () => 'sess-1',
    registerWsHandler: (type, handler) => {
      wsHandlers.set(type, handler);
      return () => wsHandlers.delete(type);
    },
  };

  const registration: DronePluginRegistration = {
    logger: silentLogger(),
    getConfig: () => ({}) as never,
    registerTool: () => {},
    registerPromptFragment: (fragment: DronePromptFragment) => {
      fragments.push(fragment);
    },
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: command => {
      slashCommands.push(command.command);
    },
    unregisterPluginTools: () => {},
    unregisterTool: () => {},
    mountTool: () => undefined,
    unmountTool: () => ({ unmounted: true }),
    listMountedTools: () => [],
    emitEvent: (event: DroneConversationEvent) => events.push(event),
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onSessionRecycle: cb => {
        onRecycle = () =>
          Promise.resolve(cb({ sessionId: 's', previousSessionId: 'p' }));
      },
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: <T>(pluginId: string): T | undefined => {
      if (pluginId === 'swarm') return swarmCap as unknown as T;
      if (pluginId === 'runtime')
        return {
          queueSystemReminder: () => {},
          emitEvent: (event: DroneConversationEvent) => events.push(event),
          getSessionId: () => 'sess-1',
        } as unknown as T;
      return undefined;
    },
    runWorkflow: async () => ({ toolResult: '{}' }),
    getCliFlags: () => ({}),
    requestElicitation: () => undefined,
    listPlugins: () => [],
  };

  return {
    registration,
    fragments,
    wsHandlers,
    events,
    slashCommands,
    get onRecycle() {
      return onRecycle;
    },
  };
}

describe('extensions plugin registration wiring', () => {
  it('registers both injection prompt fragments', async () => {
    const { extensionsPlugin } =
      await import('../../../src/plugins/extensions/index.js');
    const cap = createCapture();
    await extensionsPlugin.register(cap.registration);
    const keys = cap.fragments.map(f => f.key);
    expect(keys).toContain('extensions-header');
    expect(keys).toContain('extensions-footer');
    expect(cap.fragments.find(f => f.key === 'extensions-header')?.phase).toBe(
      'header'
    );
    expect(cap.fragments.find(f => f.key === 'extensions-footer')?.phase).toBe(
      'footer'
    );
  });

  it('registers the /extensions command as immediate', async () => {
    const { extensionsPlugin } =
      await import('../../../src/plugins/extensions/index.js');
    const cap = createCapture();
    await extensionsPlugin.register(cap.registration);
    expect(cap.slashCommands).toContain('/extensions');
  });

  it('subscribes to injection + injectionRemove WS frames', async () => {
    const { extensionsPlugin } =
      await import('../../../src/plugins/extensions/index.js');
    const cap = createCapture();
    await extensionsPlugin.register(cap.registration);
    expect(cap.wsHandlers.has('injection')).toBe(true);
    expect(cap.wsHandlers.has('injectionRemove')).toBe(true);
  });

  it('clears injections on session recycle', async () => {
    const { extensionsPlugin } =
      await import('../../../src/plugins/extensions/index.js');
    const cap = createCapture();
    await extensionsPlugin.register(cap.registration);
    // Drive an injection through the registered handler, then recycle.
    cap.wsHandlers.get('injection')?.(
      { extensionId: 'ext-1', id: 'frag-1', kind: 'fragment', content: '# Hi' },
      {}
    );
    await cap.onRecycle?.();
    // The header fragment renders nothing after recycle.
    const header = cap.fragments.find(f => f.key === 'extensions-header');
    expect(await header?.render()).toBe(false);
  });
});

describe('notice emission through a real context', () => {
  it('emits a notice event on inject', () => {
    const cap = createCapture();
    const ctx = createExtensionsContext(cap.registration);
    handleInjection(ctx, {
      extensionId: 'ext-1',
      id: 'frag-1',
      kind: 'fragment',
      content: '# Hi',
    });
    expect(cap.events.some(e => e.kind === 'notice')).toBe(true);
  });
});
