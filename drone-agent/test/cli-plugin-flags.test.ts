import { describe, expect, it } from 'vitest';
import { createDefaultAgentConfig, type DroneLogger } from 'drone-core';
import { parseCliInvocation } from '../src/index.js';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { createTestPlugin, silentLogger } from './helpers.js';

function captureLogger(): { logger: DroneLogger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      info: () => {},
      warn: (message: string) => warnings.push(message),
      error: () => {},
    },
  };
}

describe('parseCliInvocation — plugin-namespaced flags', () => {
  it('defaults pluginFlags to an empty object', () => {
    const inv = parseCliInvocation([]);
    expect(inv.options.pluginFlags).toEqual({});
  });

  it('parses --<ns>.<flag>=<value>', () => {
    const inv = parseCliInvocation(['--swarm.session-import=agent-123']);
    expect(inv.options.pluginFlags).toEqual({
      'swarm.session-import': 'agent-123',
    });
  });

  it('parses --<ns>.<flag> <value> (space-separated)', () => {
    const inv = parseCliInvocation(['--swarm.session-import', 'agent-123']);
    expect(inv.options.pluginFlags).toEqual({
      'swarm.session-import': 'agent-123',
    });
  });

  it('parses a bare --<ns>.<flag> as true', () => {
    const inv = parseCliInvocation(['--foo.verbose', '--once']);
    expect(inv.options.pluginFlags).toEqual({ 'foo.verbose': true });
    expect(inv.options.once).toBe(true);
  });

  it('collects multiple plugin flags', () => {
    const inv = parseCliInvocation([
      '--swarm.session-import',
      'a-1',
      '--herdr.resume',
      'yes',
    ]);
    expect(inv.options.pluginFlags).toEqual({
      'swarm.session-import': 'a-1',
      'herdr.resume': 'yes',
    });
  });

  it('still parses core flags alongside plugin flags', () => {
    const inv = parseCliInvocation([
      '--model',
      'ollama/llama3.1',
      '--swarm.session-import',
      'a-1',
    ]);
    expect(inv.options.modelOverride).toBe('ollama/llama3.1');
    expect(inv.options.pluginFlags['swarm.session-import']).toBe('a-1');
  });

  it('a bare flag followed by another flag does not consume it as a value', () => {
    const inv = parseCliInvocation(['--foo.verbose', '--model', 'm']);
    expect(inv.options.pluginFlags['foo.verbose']).toBe(true);
    expect(inv.options.modelOverride).toBe('m');
  });

  it('still throws on an unknown non-dotted option', () => {
    expect(() => parseCliInvocation(['--bogus'])).toThrow(/Unknown option/);
  });
});

describe('createDronePluginEngine — plugin-namespaced flags', () => {
  it('auto-enables a plugin whose id namespaces a flag', async () => {
    const engine = createDronePluginEngine({
      plugins: [createTestPlugin({ id: 'swarm', defaultEnabled: false })],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      pluginFlags: { 'swarm.session-import': 'a-1' },
    });

    await engine.initialize();
    expect(engine.listPlugins().find(p => p.id === 'swarm')?.enabled).toBe(
      true
    );
  });

  it('does not enable a plugin for an unowned namespace', async () => {
    const { logger } = captureLogger();
    const engine = createDronePluginEngine({
      plugins: [createTestPlugin({ id: 'swarm', defaultEnabled: false })],
      config: createDefaultAgentConfig(),
      logger,
      pluginFlags: { 'nope.flag': 'x' },
    });

    await engine.initialize();
    expect(engine.listPlugins().find(p => p.id === 'swarm')?.enabled).toBe(
      false
    );
  });

  it('exposes namespace-stripped flags to the owning plugin', async () => {
    let seen: Record<string, string | true> | undefined;
    const engine = createDronePluginEngine({
      plugins: [
        createTestPlugin({
          id: 'swarm',
          defaultEnabled: false,
          register: registration => {
            seen = registration.getCliFlags();
          },
        }),
      ],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
      pluginFlags: {
        'swarm.session-import': 'a-1',
        'other.flag': 'x',
      },
    });

    await engine.initialize();
    expect(seen).toEqual({ 'session-import': 'a-1' });
  });

  it('warns once per unclaimed namespace and does not throw', async () => {
    const { logger, warnings } = captureLogger();
    const engine = createDronePluginEngine({
      plugins: [createTestPlugin({ id: 'a', defaultEnabled: true })],
      config: createDefaultAgentConfig(),
      logger,
      pluginFlags: { 'ghost.flag': 'x' },
    });

    await expect(engine.initialize()).resolves.toBeDefined();
    expect(warnings.filter(w => w.includes('ghost'))).toHaveLength(1);
  });

  it('does not warn when the namespace is claimed', async () => {
    const { logger, warnings } = captureLogger();
    const engine = createDronePluginEngine({
      plugins: [createTestPlugin({ id: 'a', defaultEnabled: true })],
      config: createDefaultAgentConfig(),
      logger,
      pluginFlags: { 'a.flag': 'x' },
    });

    await engine.initialize();
    expect(warnings.filter(w => w.includes('a.*'))).toHaveLength(0);
  });
});
