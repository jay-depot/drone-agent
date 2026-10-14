import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DroneConversationEvent,
  DronePluginRegistration,
  DroneSwarmCapability,
  DroneToolDefinition,
} from 'drone-core';
import { createExtensionsContext } from '../../../src/plugins/extensions/context.js';
import {
  handleInjection,
  handleInjectionRemove,
} from '../../../src/plugins/extensions/injection-handlers.js';
import { injectedToolCanonicalName } from '../../../src/plugins/extensions/tools.js';
import { silentLogger } from '../../helpers.js';

interface Capture {
  registration: DronePluginRegistration;
  registeredTools: Map<string, DroneToolDefinition>;
  unregistered: string[];
  events: DroneConversationEvent[];
  reminders: string[];
  wsHandlers: Map<string, (payload: unknown, raw: unknown) => void>;
  unregisterTool: ReturnType<typeof vi.fn>;
}

function createCapture(): Capture {
  const registeredTools = new Map<string, DroneToolDefinition>();
  const unregistered: string[] = [];
  const events: DroneConversationEvent[] = [];
  const reminders: string[] = [];
  const wsHandlers = new Map<string, (p: unknown, r: unknown) => void>();
  const unregisterTool = vi.fn((canonical: string) => {
    unregistered.push(canonical);
    registeredTools.delete(canonical);
  });

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
    registerTool: (tool: DroneToolDefinition) => {
      registeredTools.set(`extensions__${tool.name}`, tool);
    },
    registerPromptFragment: () => {},
    registerHelp: () => {},
    registerWorkflow: () => {},
    registerSlashCommand: () => {},
    unregisterPluginTools: () => {},
    unregisterTool,
    mountTool: () => undefined,
    unmountTool: () => {},
    listMountedTools: () => [],
    emitEvent: (event: DroneConversationEvent) => events.push(event),
    hooks: {
      onPluginsLoaded: () => {},
      onSessionStart: () => {},
      onBeforePrompt: () => {},
      onAfterToolCall: () => {},
      onConversationEvent: () => {},
      onSessionClear: () => {},
      onSessionRecycle: () => {},
      onShutdown: () => {},
      onSessionSafetyTrimWillRun: () => {},
      onSessionSafetyTrimApplied: () => {},
    },
    offer: () => {},
    request: <T>(pluginId: string): T | undefined => {
      if (pluginId === 'swarm')
        return swarmCap as unknown as T;
      if (pluginId === 'runtime')
        return {
          queueSystemReminder: (content: string) => reminders.push(content),
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
    registeredTools,
    unregistered,
    events,
    reminders,
    wsHandlers,
    unregisterTool,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, status: 200, body: 'result' }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleInjection — fragment', () => {
  it('applies a fragment and emits a notice', () => {
    const cap = createCapture();
    const ctx = createExtensionsContext(cap.registration);
    handleInjection(ctx, {
      extensionId: 'ext-1',
      id: 'frag-1',
      kind: 'fragment',
      content: '# Hello',
    });
    expect(ctx.store.renderHeader()).toContain('Hello');
    expect(cap.events.some(e => e.kind === 'notice')).toBe(true);
  });
});

describe('handleInjection — reminder', () => {
  it('queues a system reminder', () => {
    const cap = createCapture();
    const ctx = createExtensionsContext(cap.registration);
    handleInjection(ctx, {
      extensionId: 'ext-1',
      id: 'rem-1',
      kind: 'reminder',
      content: 'Remember this',
    });
    expect(cap.reminders[0]).toContain('Remember this');
    expect(cap.reminders[0]).toContain('ext-1');
  });
});

describe('handleInjection — tools', () => {
  it('registers an injected tool unmounted with the canonical name', () => {
    const cap = createCapture();
    const ctx = createExtensionsContext(cap.registration);
    handleInjection(ctx, {
      extensionId: 'ext-1',
      id: 'tools-1',
      kind: 'tools',
      tools: [
        {
          capability: 'echo',
          description: 'Echo input',
          paramSchema: { type: 'object' },
        },
      ],
    });
    const canonical = injectedToolCanonicalName('ext-1', 'echo');
    const tool = cap.registeredTools.get(canonical);
    expect(tool).toBeDefined();
    expect(tool?.description).toBe('Echo input');
    expect(cap.registeredTools.has(canonical)).toBe(true);
  });

  it('unregisters the tool when its selection is removed', () => {
    const cap = createCapture();
    const ctx = createExtensionsContext(cap.registration);
    handleInjection(ctx, {
      extensionId: 'ext-1',
      id: 'tools-1',
      kind: 'tools',
      tools: [{ capability: 'echo', description: 'Echo' }],
    });
    const canonical = injectedToolCanonicalName('ext-1', 'echo');
    expect(cap.registeredTools.has(canonical)).toBe(true);

    handleInjectionRemove(ctx, {
      extensionId: 'ext-1',
      kind: 'tools',
      tools: [{ capability: 'echo' }],
    });
    expect(cap.unregistered).toContain(canonical);
    expect(cap.registeredTools.has(canonical)).toBe(false);
  });

  it('proxies a tool call through the beacon /coordinator route', async () => {
    const cap = createCapture();
    const ctx = createExtensionsContext(cap.registration);
    handleInjection(ctx, {
      extensionId: 'ext-1',
      id: 'tools-1',
      kind: 'tools',
      tools: [{ capability: 'echo', description: 'Echo' }],
    });
    const tool = cap.registeredTools.get(
      injectedToolCanonicalName('ext-1', 'echo')
    );
    const result = await tool!.execute({ q: 'hi' });
    expect(result).toBe('result');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://beacon.test/coordinator/extensions/ext-1/tools/echo',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('returns a tool-error string on a non-2xx response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 504,
      json: async () => ({ ok: false, status: 504, body: { error: 'timeout' } }),
    });
    const cap = createCapture();
    const ctx = createExtensionsContext(cap.registration);
    handleInjection(ctx, {
      extensionId: 'ext-1',
      id: 'tools-1',
      kind: 'tools',
      tools: [{ capability: 'echo', description: 'Echo' }],
    });
    const tool = cap.registeredTools.get(
      injectedToolCanonicalName('ext-1', 'echo')
    );
    const result = await tool!.execute({});
    expect(result).toContain('extension error');
  });

  it('returns a tool-error string on a network failure (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const cap = createCapture();
    const ctx = createExtensionsContext(cap.registration);
    handleInjection(ctx, {
      extensionId: 'ext-1',
      id: 'tools-1',
      kind: 'tools',
      tools: [{ capability: 'echo', description: 'Echo' }],
    });
    const tool = cap.registeredTools.get(
      injectedToolCanonicalName('ext-1', 'echo')
    );
    const result = await tool!.execute({});
    expect(result).toContain('extension did not respond');
  });
});

describe('handleInjectionRemove — generic removal', () => {
  it('removes a fragment by injection id', () => {
    const cap = createCapture();
    const ctx = createExtensionsContext(cap.registration);
    handleInjection(ctx, {
      extensionId: 'ext-1',
      id: 'frag-1',
      kind: 'fragment',
      content: '# Hi',
    });
    handleInjectionRemove(ctx, {
      extensionId: 'ext-1',
      kind: 'fragment',
      injectionId: 'frag-1',
    });
    expect(ctx.store.renderHeader()).toBe(false);
  });
});
