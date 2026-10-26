/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig,
  type DronePersonaDefinition,
  type DronePersonaProvider,
  type DroneToolDefinition,
  type DroneToolDescriptor,
} from 'drone-core';

import { personaPlugin } from '../src/plugins/persona/index.js';
import { createTestEngine, createTestPlugin, silentLogger } from './helpers.js';

function makeTool(
  name: string,
  opts: { defaultHidden?: boolean; alwaysVisible?: boolean } = {}
): DroneToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    defaultHidden: opts.defaultHidden,
    alwaysVisible: opts.alwaysVisible,
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

type FilteredCapability = {
  registerProvider: (p: DronePersonaProvider) => void;
  reloadPersonas: () => Promise<void>;
  getFilteredTools: (tools: DroneToolDescriptor[]) => DroneToolDescriptor[];
};

async function createEngine(
  personas: DronePersonaDefinition[],
  tools: DroneToolDefinition[]
) {
  const config = createDefaultAgentConfig();
  config.enabledPlugins = { persona: true, file: true };
  const engine = createTestEngine({
    plugins: [createTestPlugin({ id: 'file', tools }), personaPlugin],
    config,
    logger: silentLogger(),
  });
  await engine.initialize();

  const personaCap = engine.getCapability<FilteredCapability>('persona');
  personaCap!.registerProvider(makeProvider(personas));
  await personaCap!.reloadPersonas();
  return { engine, personaCap: personaCap! };
}

describe('persona tool visibility — alwaysVisible exemption', () => {
  it('an alwaysVisible tool survives an allowedTools list that does not match it', async () => {
    const { engine, personaCap } = await createEngine(
      [
        {
          id: 'coder',
          name: 'Coder',
          description: 'Code persona',
          allowedTools: ['file__read'],
        },
      ],
      [
        makeTool('read'),
        makeTool('write'),
        makeTool('meta', { alwaysVisible: true }),
      ]
    );

    await engine.executeTool('persona__select', { id: 'coder' });

    const filtered = personaCap.getFilteredTools(engine.listAllTools());
    const names = filtered.map(t => t.name);
    expect(names).toContain('file__meta');
    expect(names).toContain('file__read');
    expect(names).not.toContain('file__write');
  });

  it('an allowedTools `!` exclusion hides an alwaysVisible tool', async () => {
    const { engine, personaCap } = await createEngine(
      [
        {
          id: 'coder',
          name: 'Coder',
          description: 'Code persona',
          allowedTools: ['file__read', '!file__meta*'],
        },
      ],
      [makeTool('read'), makeTool('meta', { alwaysVisible: true })]
    );

    await engine.executeTool('persona__select', { id: 'coder' });

    const filtered = personaCap.getFilteredTools(engine.listAllTools());
    const names = filtered.map(t => t.name);
    expect(names).toContain('file__read');
    expect(names).not.toContain('file__meta');
  });

  it('leaves the premountedTools union behaviour unchanged', async () => {
    const { engine, personaCap } = await createEngine(
      [
        {
          id: 'coder',
          name: 'Coder',
          description: 'Code persona',
          allowedTools: ['file__read'],
          premountedTools: { file: ['write'] },
        },
      ],
      [makeTool('read'), makeTool('write'), makeTool('delete')]
    );

    await engine.executeTool('persona__select', { id: 'coder' });

    const filtered = personaCap.getFilteredTools(engine.listAllTools());
    const names = filtered.map(t => t.name);
    expect(names).toContain('file__read');
    // premounted continues to force-include a name allowedTools excludes
    expect(names).toContain('file__write');
    expect(names).not.toContain('file__delete');
  });

  it('keeps the runtime meta-tools visible when a persona names an unmatched allowedTools entry', async () => {
    const { engine, personaCap } = await createEngine(
      [
        {
          id: 'coder',
          name: 'Coder',
          description: 'Code persona',
          allowedTools: ['file__read'],
        },
      ],
      [makeTool('read'), makeTool('write'), makeTool('delete')]
    );

    await engine.executeTool('persona__select', { id: 'coder' });

    const filtered = personaCap.getFilteredTools(engine.listTools());
    const names = filtered.map(t => t.name);
    expect(names).toContain('runtime__list_tools');
    expect(names).toContain('runtime__mount_tool');
    expect(names).toContain('runtime__unmount_tool');
  });

  it('force-includes a premounted tool even when a `!` exclusion matches it', async () => {
    const { engine, personaCap } = await createEngine(
      [
        {
          id: 'coder',
          name: 'Coder',
          description: 'Code persona',
          allowedTools: ['file__read', '!file__write'],
          premountedTools: { file: ['write'] },
        },
      ],
      [makeTool('read'), makeTool('write'), makeTool('delete')]
    );

    await engine.executeTool('persona__select', { id: 'coder' });

    const filtered = personaCap.getFilteredTools(engine.listAllTools());
    const names = filtered.map(t => t.name);
    expect(names).toContain('file__write');
    expect(names).toContain('file__read');
    expect(names).not.toContain('file__delete');
  });
});
