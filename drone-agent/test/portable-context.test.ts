import { describe, expect, it, vi } from 'vitest';
import type {
  DronePortableContextExport,
  DroneToolDescriptor,
} from 'drone-core';
import { createPortableContextCapability } from '../src/runtime/portable-context/index.js';
import { createSessionManager } from '../src/runtime/session-manager.js';
import { silentLogger } from './helpers.js';

type Harness = {
  capability: ReturnType<typeof createPortableContextCapability>;
  sessionManager: ReturnType<typeof createSessionManager>;
  clearCalls: string[];
  events: Array<{ kind: string; content?: string }>;
  registered: Set<string>;
  mounted: () => Set<string>;
};

function makeHarness(options?: {
  allTools?: DroneToolDescriptor[];
  mountedTools?: DroneToolDescriptor[];
}): Harness {
  const sessionManager = createSessionManager();
  const allTools = options?.allTools ?? [];
  const mountedTools = options?.mountedTools ?? [];
  const mounted = new Set(mountedTools.map(t => t.name));
  const registered = new Set(allTools.map(t => t.name));
  const clearCalls: string[] = [];
  const events: Array<{ kind: string; content?: string }> = [];

  const capability = createPortableContextCapability({
    sessionManager,
    listAllTools: () => allTools,
    listMountedTools: () => allTools.filter(t => mounted.has(t.name)),
    mountTool: name => {
      mounted.add(name);
      return {};
    },
    isToolRegistered: name => registered.has(name),
    clearSession: async () => {
      clearCalls.push('clear');
      sessionManager.clearSession();
    },
    getSessionId: () => 'session-1',
    emitEvent: event => {
      events.push(event);
    },
    logger: silentLogger(),
  });

  return {
    capability,
    sessionManager,
    clearCalls,
    events,
    registered,
    mounted: () => new Set(mounted),
  };
}

describe('portable-context capability', () => {
  it('exports all turns, keeping summaries inline and dropping turn ids', async () => {
    const h = makeHarness({
      allTools: [
        { name: 'file__read', description: 'read' },
        { name: 'todo__manage_list', description: 'todo' },
      ],
      mountedTools: [{ name: 'file__read', description: 'read' }],
    });
    h.sessionManager.appendUserMessage('hello');
    h.sessionManager.appendAssistantMessage('hi');
    h.sessionManager.prependSystemTurn('summary block', { kind: 'summary' });

    const exported = await h.capability.exportContext();
    expect(exported.version).toBe(1);
    expect(exported.session.sourceSessionId).toBe('session-1');
    expect(exported.session.turns).toHaveLength(3);
    expect(exported.session.turns[0].kind).toBe('summary');
    // Turn ids are not serialized.
    expect('id' in exported.session.turns[0]).toBe(false);
    const fileTool = exported.tools.find(t => t.name === 'file__read');
    const todoTool = exported.tools.find(t => t.name === 'todo__manage_list');
    expect(fileTool?.mounted).toBe(true);
    expect(todoTool?.mounted).toBe(false);
  });

  it('round-trips turns with fresh ids and restores pluginData', async () => {
    const h = makeHarness();
    h.sessionManager.appendUserMessage('hello');
    const contributorImport = vi.fn();
    h.capability.registerContributor({
      id: 'focus',
      export: () => ({ currentFocus: 'ship it' }),
      import: contributorImport,
    });

    const exported = await h.capability.exportContext();
    expect(exported.pluginData.focus).toEqual({ currentFocus: 'ship it' });

    // Import into an empty session: the clear boundary is a no-op (no turns),
    // but the turns are injected and contributors restored.
    const result = await h.capability.importContext(exported);
    expect(result.warnings).toEqual([]);
    const turns = h.sessionManager.getTurns();
    // hello + assistant + disclosure turn.
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(contributorImport).toHaveBeenCalledOnce();
    expect(h.events.some(e => e.kind === 'notice')).toBe(true);
  });

  it('rejects an out-of-range version without mutating the session', async () => {
    const h = makeHarness();
    h.sessionManager.appendUserMessage('keep me');
    const bad: DronePortableContextExport = {
      version: 99,
      createdAt: new Date().toISOString(),
      session: { turns: [] },
      tools: [],
      pluginData: {},
    };
    await expect(h.capability.importContext(bad)).rejects.toThrow(/version/i);
    // Session untouched, no clear ran.
    expect(h.sessionManager.getTurns()).toHaveLength(1);
    expect(h.clearCalls).toEqual([]);
  });

  it('remounts mounted tools additively and lists unavailable ones', async () => {
    const h = makeHarness({
      allTools: [{ name: 'file__read', description: 'read' }],
      mountedTools: [],
    });
    const exported: DronePortableContextExport = {
      version: 1,
      createdAt: new Date().toISOString(),
      session: { sourceSessionId: 's0', turns: [] },
      tools: [
        { name: 'file__read', description: 'read', mounted: true },
        { name: 'gone__tool', description: 'gone', mounted: true },
        { name: 'unmounted__tool', description: 'um', mounted: false },
      ],
      pluginData: {},
    };
    const result = await h.capability.importContext(exported);
    expect(result.unavailableTools).toEqual(['gone__tool']);
    expect(h.mounted().has('file__read')).toBe(true);
    expect(h.mounted().has('unmounted__tool')).toBe(false);
  });

  it('writes the continuation disclosure as a stored user turn', async () => {
    const h = makeHarness();
    const exported: DronePortableContextExport = {
      version: 1,
      createdAt: '2026-10-11T00:00:00.000Z',
      session: { sourceSessionId: 'prev-session', turns: [] },
      tools: [{ name: 'gone__tool', description: 'g', mounted: true }],
      pluginData: {},
    };
    await h.capability.importContext(exported);
    const turns = h.sessionManager.getTurns();
    const disclosure = turns.at(-1);
    expect(disclosure?.messages[0].role).toBe('user');
    expect(disclosure?.messages[0].content).toContain(
      'restored from a prior checkpoint taken from session prev-session'
    );
    expect(disclosure?.messages[0].content).toContain('gone__tool');
  });

  it('warns on unknown pluginData keys and skips missing contributors', async () => {
    const h = makeHarness();
    const importSpy = vi.fn();
    h.capability.registerContributor({
      id: 'focus',
      export: () => ({}),
      import: importSpy,
    });
    const exported: DronePortableContextExport = {
      version: 1,
      createdAt: new Date().toISOString(),
      session: { turns: [] },
      tools: [],
      pluginData: { unknown: { x: 1 } },
    };
    const result = await h.capability.importContext(exported);
    expect(result.warnings).toContain(
      'unknown pluginData key ignored: unknown'
    );
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('collects contributor import failures as soft warnings', async () => {
    const h = makeHarness();
    h.capability.registerContributor({
      id: 'focus',
      export: () => ({ bad: true }),
      import: () => {
        throw new Error('boom');
      },
    });
    const exported = await h.capability.exportContext();
    const result = await h.capability.importContext(exported);
    expect(result.warnings).toContain('focus: boom');
  });
});
