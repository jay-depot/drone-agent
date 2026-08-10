/**
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultAgentConfig,
  type DronePersonaDefinition,
  type DronePersonaProvider,
  type DroneToolDefinition,
} from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { personaPlugin } from '../src/plugins/persona/index.js';
import { createTestPlugin, silentLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string, defaultHidden = false): DroneToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    defaultHidden,
    execute: async () => 'done',
  };
}

function makeProvider(
  personas: DronePersonaDefinition[]
): DronePersonaProvider {
  const map = new Map(personas.map(p => [p.id, p]));
  return {
    id: 'test-provider',
    precedence: 10,
    getPersonas: () => Array.from(map.values()),
    getPersona: (id: string) => map.get(id),
    reloadPersonas: async () => {},
  };
}

async function createTestEngine(
  personas: DronePersonaDefinition[],
  tools: DroneToolDefinition[] = []
) {
  const config = createDefaultAgentConfig();
  config.enabledPlugins = ['persona', 'file'];
  const engine = createDronePluginEngine({
    plugins: [
      createTestPlugin({
        id: 'file',
        tools,
      }),
      personaPlugin,
    ],
    config,
    logger: silentLogger(),
  });
  await engine.initialize();

  const personaCap = engine.getCapability<{
    registerProvider: (p: DronePersonaProvider) => void;
    reloadPersonas: () => Promise<void>;
  }>('persona');
  personaCap!.registerProvider(makeProvider(personas));
  await personaCap!.reloadPersonas();

  return engine;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('persona premount engine', () => {
  it('mounts premounted tools on persona activation', async () => {
    const tools = [makeTool('read'), makeTool('list'), makeTool('apply_diff')];
    const engine = await createTestEngine(
      [
        {
          id: 'coder',
          name: 'Coder',
          description: 'Code persona',
          premountedTools: { file: ['read', 'list'] },
        },
      ],
      tools
    );

    // Initially only runtime tools are mounted
    const initial = engine.listTools();
    expect(initial.every(t => t.name.startsWith('runtime__'))).toBe(true);

    await engine.executeTool('persona__select', { id: 'coder' });

    const mounted = engine.listTools();
    const names = mounted.map(t => t.name);
    expect(names).toContain('file__read');
    expect(names).toContain('file__list');
    expect(names).not.toContain('file__apply_diff');
    // runtime tools remain
    expect(names.some(n => n.startsWith('runtime__'))).toBe(true);
  });

  it('unmounts previous persona tools and mounts new persona tools on switch', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona', 'file', 'git'];
    const engine = createDronePluginEngine({
      plugins: [
        createTestPlugin({
          id: 'file',
          tools: [makeTool('read'), makeTool('list')],
        }),
        createTestPlugin({ id: 'git', tools: [makeTool('commit')] }),
        personaPlugin,
      ],
      config,
      logger: silentLogger(),
    });
    await engine.initialize();

    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
      reloadPersonas: () => Promise<void>;
    }>('persona');
    personaCap!.registerProvider(
      makeProvider([
        {
          id: 'persona-a',
          name: 'Persona A',
          description: 'A',
          premountedTools: { file: ['read', 'list'] },
        },
        {
          id: 'persona-b',
          name: 'Persona B',
          description: 'B',
          premountedTools: { git: ['commit'] },
        },
      ])
    );
    await personaCap!.reloadPersonas();

    await engine.executeTool('persona__select', { id: 'persona-a' });
    let names = engine.listTools().map(t => t.name);
    expect(names).toContain('file__read');
    expect(names).toContain('file__list');

    await engine.executeTool('persona__select', { id: 'persona-b' });
    names = engine.listTools().map(t => t.name);
    expect(names).toContain('git__commit');
    expect(names).not.toContain('file__read');
    expect(names).not.toContain('file__list');
  });

  it('clearing persona unmounts all non-runtime tools', async () => {
    const tools = [makeTool('read')];
    const engine = await createTestEngine(
      [
        {
          id: 'persona-a',
          name: 'Persona A',
          description: 'A',
          premountedTools: { file: ['read'] },
        },
      ],
      tools
    );

    await engine.executeTool('persona__select', { id: 'persona-a' });
    expect(engine.listTools().map(t => t.name)).toContain('file__read');

    await engine.executeTool('persona__select', { id: 'none' });
    const names = engine.listTools().map(t => t.name);
    expect(names).not.toContain('file__read');
    // All remaining tools are runtime meta-tools
    expect(names.every(n => n.startsWith('runtime__'))).toBe(true);
  });

  it('runtime__ tools remain mounted across a persona change', async () => {
    const engine = await createTestEngine([
      {
        id: 'persona-a',
        name: 'Persona A',
        description: 'A',
        premountedTools: {},
      },
    ]);

    const before = engine.listTools().map(t => t.name);
    expect(before.some(n => n.startsWith('runtime__'))).toBe(true);

    await engine.executeTool('persona__select', { id: 'persona-a' });

    const after = engine.listTools().map(t => t.name);
    // runtime__list_tools, runtime__mount_tool, runtime__unmount_tool stay
    expect(after.some(n => n.startsWith('runtime__'))).toBe(true);
  });

  it('session-start activation premounts via onSessionStart hook', async () => {
    const tools = [makeTool('read')];
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona', 'file'];
    config.activePersona = 'coder';

    const engine = createDronePluginEngine({
      plugins: [
        createTestPlugin({
          id: 'file',
          tools,
        }),
        personaPlugin,
      ],
      config,
      logger: silentLogger(),
    });
    await engine.initialize();

    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
      reloadPersonas: () => Promise<void>;
    }>('persona');
    personaCap!.registerProvider(
      makeProvider([
        {
          id: 'coder',
          name: 'Coder',
          description: 'Code persona',
          premountedTools: { file: ['read'] },
        },
      ])
    );
    await personaCap!.reloadPersonas();

    // Run onSessionStart which activates the configured persona
    await engine.runHooks('onSessionStart');

    const names = engine.listTools().map(t => t.name);
    expect(names).toContain('file__read');
  });

  it('premounting a defaultHidden tool makes it visible via getFilteredTools even when not in allowedTools', async () => {
    const tools = [makeTool('read', true)]; // defaultHidden
    const engine = await createTestEngine(
      [
        {
          id: 'coder',
          name: 'Coder',
          description: 'Code persona',
          premountedTools: { file: ['read'] },
        },
      ],
      tools
    );

    await engine.executeTool('persona__select', { id: 'coder' });

    // The tool is mounted and visible
    const names = engine.listTools().map(t => t.name);
    expect(names).toContain('file__read');

    // getFilteredTools also includes it despite defaultHidden
    const personaCap = engine.getCapability<{
      getFilteredTools: (
        tools: import('drone-core').DroneToolDescriptor[]
      ) => import('drone-core').DroneToolDescriptor[];
    }>('persona');
    const all = engine.listAllTools();
    const filtered = personaCap!.getFilteredTools(all);
    expect(filtered.map(t => t.name)).toContain('file__read');
  });

  it('warns for a premounted unknown tool', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona', 'file'];

    const engine = createDronePluginEngine({
      plugins: [
        createTestPlugin({
          id: 'file',
          tools: [makeTool('read')],
        }),
        personaPlugin,
      ],
      config,
    });
    await engine.initialize();

    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
      reloadPersonas: () => Promise<void>;
    }>('persona');
    personaCap!.registerProvider(
      makeProvider([
        {
          id: 'coder',
          name: 'Coder',
          description: 'Code persona',
          premountedTools: { file: ['nonexistent_tool'] },
        },
      ])
    );
    await personaCap!.reloadPersonas();

    await engine.executeTool('persona__select', { id: 'coder' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'premountedTools: unknown tool "file__nonexistent_tool"'
      )
    );
    warnSpy.mockRestore();
  });

  it('warns for a premounted defaultHidden tool not in allowedTools', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona', 'file'];

    const engine = createDronePluginEngine({
      plugins: [
        createTestPlugin({
          id: 'file',
          tools: [makeTool('read', true)],
        }),
        personaPlugin,
      ],
      config,
    });
    await engine.initialize();

    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
      reloadPersonas: () => Promise<void>;
    }>('persona');
    personaCap!.registerProvider(
      makeProvider([
        {
          id: 'coder',
          name: 'Coder',
          description: 'Code persona',
          premountedTools: { file: ['read'] },
        },
      ])
    );
    await personaCap!.reloadPersonas();

    await engine.executeTool('persona__select', { id: 'coder' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('is defaultHidden and not in allowedTools')
    );
    warnSpy.mockRestore();
  });
});
