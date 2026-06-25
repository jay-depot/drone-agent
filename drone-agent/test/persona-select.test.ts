/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig,
  type DronePersonaProvider,
} from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { personaPlugin } from '../src/plugins/persona/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(
  personas: { id: string; name: string }[]
): DronePersonaProvider {
  const map = new Map(personas.map(p => [p.id, p]));
  return {
    id: 'test-provider',
    precedence: 10,
    getPersonas: () =>
      Array.from(map.values()).map(p => ({
        id: p.id,
        name: p.name,
        description: `Description for ${p.name}`,
      })),
    getPersona: (id: string) => {
      const p = map.get(id);
      if (!p) return undefined;
      return {
        id: p.id,
        name: p.name,
        description: `Description for ${p.name}`,
      };
    },
    reloadPersonas: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('persona.select tool — graceful error handling', () => {
  it('returns a graceful error with available personas when selecting an unknown id', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona'];
    const engine = createDronePluginEngine({
      plugins: [personaPlugin],
      config,
    });
    await engine.initialize();

    // Register a mock provider with some personas
    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
    }>('persona');
    expect(personaCap).toBeDefined();
    personaCap!.registerProvider(
      makeMockProvider([
        { id: 'coder', name: 'Coder' },
        { id: 'planner', name: 'Planner' },
        { id: 'reviewer', name: 'Reviewer' },
      ])
    );

    // Reload to pick up the provider's personas
    const reloadCap = engine.getCapability<{
      reloadPersonas: () => Promise<void>;
    }>('persona');
    await reloadCap!.reloadPersonas();

    // Try selecting a typo'd persona
    const result = await engine.executeTool('persona.select', { id: 'plna' });
    const parsed = JSON.parse(result);

    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain('Unknown persona "plna"');
    expect(parsed.message).toContain('coder');
    expect(parsed.message).toContain('planner');
    expect(parsed.message).toContain('reviewer');
  });

  it('still works for a valid persona id', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona'];
    const engine = createDronePluginEngine({
      plugins: [personaPlugin],
      config,
    });
    await engine.initialize();

    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
    }>('persona');
    personaCap!.registerProvider(
      makeMockProvider([{ id: 'coder', name: 'Coder' }])
    );

    const reloadCap = engine.getCapability<{
      reloadPersonas: () => Promise<void>;
    }>('persona');
    await reloadCap!.reloadPersonas();

    const result = await engine.executeTool('persona.select', { id: 'coder' });
    const parsed = JSON.parse(result);

    expect(parsed.error).toBeUndefined();
    expect(parsed.activePersona).toBe('coder');
    expect(parsed.name).toBe('Coder');
    expect(parsed.message).toContain('Switched to persona');
  });

  it('returns graceful error with "(none)" when no personas are loaded', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona'];
    const engine = createDronePluginEngine({
      plugins: [personaPlugin],
      config,
    });
    await engine.initialize();

    // No provider registered — no personas
    const result = await engine.executeTool('persona.select', {
      id: 'anything',
    });
    const parsed = JSON.parse(result);

    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain('(none)');
  });
});
