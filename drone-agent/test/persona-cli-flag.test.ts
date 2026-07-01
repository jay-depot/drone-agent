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

describe('--persona CLI flag', () => {
  it('exposes _runtime capability even without subagent plugin enabled', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona'];
    const engine = createDronePluginEngine({
      plugins: [personaPlugin],
      config,
      runtimeOptions: {
        persona: 'coder',
      },
    });
    await engine.initialize();

    // The _runtime capability should be available even though subagent
    // is not enabled
    const runtime = engine.getCapability<{ persona?: string }>('_runtime');
    expect(runtime).toBeDefined();
    expect(runtime?.persona).toBe('coder');
  });

  it('activates persona from --persona flag via onSessionStart', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona'];
    const engine = createDronePluginEngine({
      plugins: [personaPlugin],
      config,
      runtimeOptions: {
        persona: 'coder',
      },
    });
    await engine.initialize();

    // Register a mock provider with personas
    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
      reloadPersonas: () => Promise<void>;
      getActivePersona: () => { id: string; name: string } | null;
    }>('persona');
    expect(personaCap).toBeDefined();
    personaCap!.registerProvider(
      makeMockProvider([{ id: 'coder', name: 'Coder' }])
    );
    await personaCap!.reloadPersonas();

    // Before onSessionStart, no persona should be active
    expect(personaCap!.getActivePersona()).toBeNull();

    // Run onSessionStart hooks — this should activate the persona
    await engine.runHooks('onSessionStart');

    const active = personaCap!.getActivePersona();
    expect(active).not.toBeNull();
    expect(active!.id).toBe('coder');
    expect(active!.name).toBe('Coder');
  });

  it('activates persona from --persona flag even when provider registers after onPluginsLoaded', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona'];
    const engine = createDronePluginEngine({
      plugins: [personaPlugin],
      config,
      runtimeOptions: {
        persona: 'swarm-persona',
      },
    });
    await engine.initialize();

    // Simulate a swarm-like provider that registers after onPluginsLoaded
    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
      reloadPersonas: () => Promise<void>;
      getActivePersona: () => { id: string; name: string } | null;
    }>('persona');
    expect(personaCap).toBeDefined();

    // Run onPluginsLoaded first (swarm registers its providers here)
    await engine.runHooks('onPluginsLoaded');

    // Now register a provider (simulating swarm's onPluginsLoaded)
    personaCap!.registerProvider(
      makeMockProvider([{ id: 'swarm-persona', name: 'Swarm Persona' }])
    );
    await personaCap!.reloadPersonas();

    // Now run onSessionStart — the persona should be found and activated
    await engine.runHooks('onSessionStart');

    const active = personaCap!.getActivePersona();
    expect(active).not.toBeNull();
    expect(active!.id).toBe('swarm-persona');
    expect(active!.name).toBe('Swarm Persona');
  });

  it('falls back to config.activePersona when --persona is not provided', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona'];
    config.activePersona = 'planner';
    const engine = createDronePluginEngine({
      plugins: [personaPlugin],
      config,
      // No runtimeOptions.persona
    });
    await engine.initialize();

    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
      reloadPersonas: () => Promise<void>;
      getActivePersona: () => { id: string; name: string } | null;
    }>('persona');
    expect(personaCap).toBeDefined();
    personaCap!.registerProvider(
      makeMockProvider([
        { id: 'coder', name: 'Coder' },
        { id: 'planner', name: 'Planner' },
      ])
    );
    await personaCap!.reloadPersonas();

    // Run onSessionStart — should activate planner from config
    await engine.runHooks('onSessionStart');

    const active = personaCap!.getActivePersona();
    expect(active).not.toBeNull();
    expect(active!.id).toBe('planner');
  });

  it('--persona flag takes precedence over config.activePersona', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona'];
    config.activePersona = 'planner';
    const engine = createDronePluginEngine({
      plugins: [personaPlugin],
      config,
      runtimeOptions: {
        persona: 'coder',
      },
    });
    await engine.initialize();

    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
      reloadPersonas: () => Promise<void>;
      getActivePersona: () => { id: string; name: string } | null;
    }>('persona');
    expect(personaCap).toBeDefined();
    personaCap!.registerProvider(
      makeMockProvider([
        { id: 'coder', name: 'Coder' },
        { id: 'planner', name: 'Planner' },
      ])
    );
    await personaCap!.reloadPersonas();

    // Run onSessionStart — should activate coder (from --persona), not planner
    await engine.runHooks('onSessionStart');

    const active = personaCap!.getActivePersona();
    expect(active).not.toBeNull();
    expect(active!.id).toBe('coder');
  });

  it('logs a warning when --persona id is not found', async () => {
    const config = createDefaultAgentConfig();
    config.enabledPlugins = ['persona'];
    const engine = createDronePluginEngine({
      plugins: [personaPlugin],
      config,
      runtimeOptions: {
        persona: 'nonexistent',
      },
    });
    await engine.initialize();

    const personaCap = engine.getCapability<{
      registerProvider: (p: DronePersonaProvider) => void;
      reloadPersonas: () => Promise<void>;
      getActivePersona: () => { id: string; name: string } | null;
    }>('persona');
    expect(personaCap).toBeDefined();
    personaCap!.registerProvider(
      makeMockProvider([{ id: 'coder', name: 'Coder' }])
    );
    await personaCap!.reloadPersonas();

    // Run onSessionStart — should not crash, just log a warning
    await engine.runHooks('onSessionStart');

    const active = personaCap!.getActivePersona();
    expect(active).toBeNull();
  });
});
