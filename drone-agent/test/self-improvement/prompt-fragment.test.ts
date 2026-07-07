import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createEngine } from './setup.js';

describe('insight-targets prompt fragment', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `self-improvement-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir('/');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('renders the current active persona when persona plugin is loaded and a persona is active', async () => {
    const personaCap = {
      getPersonas: () => [
        { id: 'code', name: 'Code', description: 'A coding persona' },
      ],
      getActivePersona: () => ({
        id: 'code',
        name: 'Code',
        description: 'A coding persona',
      }),
      selectPersona: () => {},
      onPersonaChange: () => {},
      reloadPersonas: async () => {},
    };

    const engine = await createEngine({ personaCapability: personaCap });
    const fragments = await engine.renderPromptFragments();
    const fragment = fragments.find(f => f.includes('Current active persona'));
    expect(fragment).toBeDefined();
    expect(fragment).toContain('code');
    expect(fragment).toContain('self-improvement__insight');
    expect(fragment).toContain('persona__list');
    expect(fragment).toContain('skills__list');
  });

  it('omits the active persona line when no persona is active', async () => {
    const personaCap = {
      getPersonas: () => [
        { id: 'code', name: 'Code', description: 'A coding persona' },
      ],
      getActivePersona: () => null,
      selectPersona: () => {},
      onPersonaChange: () => {},
      reloadPersonas: async () => {},
    };

    const engine = await createEngine({ personaCapability: personaCap });
    const fragments = await engine.renderPromptFragments();
    const fragment = fragments.find(f => f.includes('persona__list'));
    expect(fragment).toBeDefined();
    expect(fragment).not.toContain('Current active persona');
    expect(fragment).toContain('persona__list');
    expect(fragment).toContain('skills__list');
  });

  it('renders the discovery hint when neither persona nor skills plugins are loaded', async () => {
    const engine = await createEngine();
    const fragments = await engine.renderPromptFragments();
    const fragment = fragments.find(f => f.includes('persona__list'));
    expect(fragment).toBeDefined();
    expect(fragment).toContain('persona__list');
    expect(fragment).toContain('skills__list');
    expect(fragment).not.toContain('Current active persona');
  });

  it('mentions the new insight and principle tools', async () => {
    const engine = await createEngine();
    const fragments = await engine.renderPromptFragments();
    const fragment = fragments.find(f => f.includes('Insight tools'));
    expect(fragment).toBeDefined();
    expect(fragment).toContain('insights-list');
    expect(fragment).toContain('insights-recall');
    expect(fragment).toContain('principles-store');
    expect(fragment).toContain('principles-list');
    expect(fragment).toContain('principles-recall');
    expect(fragment).toContain('principles-delete');
  });
});
