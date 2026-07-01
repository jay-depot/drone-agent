import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createDefaultAgentConfig,
  type DronePlugin,
  type DroneToolDefinition,
} from 'drone-core';
import {
  loadPluginFromDirectory,
  loadTrustedPlugins,
  saveTrustedPlugin,
  discoverExternalPlugins,
} from '../src/plugins/external-loader.js';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { createTestPlugin, silentLogger } from './helpers.js';

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir: string;
let projectDir: string;

async function createTempDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `drone-external-loader-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writePluginFile(
  pluginDir: string,
  pluginId: string,
  content: string
): Promise<string> {
  const dir = path.join(pluginDir, pluginId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'index.js');
  await writeFile(filePath, content, 'utf-8');
  return dir;
}

function makeValidPluginSource(id: string, toolName: string): string {
  return `
export const plugin = {
  metadata: {
    id: '${id}',
    name: '${id}',
    version: '1.0.0',
    description: 'Test plugin ${id}',
  },
  register: async (registration) => {
    registration.registerTool({
      name: '${toolName}',
      description: '${toolName} tool',
      inputSchema: { type: 'object', additionalProperties: false },
      execute: async () => '${toolName} result',
    });
  },
};
`;
}

function makeValidPluginDefaultExport(id: string, toolName: string): string {
  return `
export default {
  metadata: {
    id: '${id}',
    name: '${id}',
    version: '1.0.0',
    description: 'Test plugin ${id}',
  },
  register: async (registration) => {
    registration.registerTool({
      name: '${toolName}',
      description: '${toolName} tool',
      inputSchema: { type: 'object', additionalProperties: false },
      execute: async () => '${toolName} result',
    });
  },
};
`;
}

// ── Tests ───────────────────────────────────────────────────────────

describe('loadPluginFromDirectory', () => {
  beforeEach(async () => {
    tmpDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads a valid plugin from index.js with named export', async () => {
    const pluginDir = await writePluginFile(
      tmpDir,
      'test-plugin',
      makeValidPluginSource('test-plugin', 'ping')
    );
    const plugin = await loadPluginFromDirectory(pluginDir);
    expect(plugin).not.toBeNull();
    expect(plugin!.metadata.id).toBe('test-plugin');
    expect(plugin!.metadata.name).toBe('test-plugin');
    expect(typeof plugin!.register).toBe('function');
  });

  it('loads a valid plugin from index.js with default export', async () => {
    const pluginDir = await writePluginFile(
      tmpDir,
      'default-plugin',
      makeValidPluginDefaultExport('default-plugin', 'pong')
    );
    const plugin = await loadPluginFromDirectory(pluginDir);
    expect(plugin).not.toBeNull();
    expect(plugin!.metadata.id).toBe('default-plugin');
  });

  it('returns null for a directory without index.js', async () => {
    const emptyDir = path.join(tmpDir, 'empty-plugin');
    await mkdir(emptyDir, { recursive: true });
    const plugin = await loadPluginFromDirectory(emptyDir);
    expect(plugin).toBeNull();
  });

  it('returns null for a non-existent directory', async () => {
    const plugin = await loadPluginFromDirectory(
      path.join(tmpDir, 'nonexistent')
    );
    expect(plugin).toBeNull();
  });

  it('returns null for a plugin with invalid exports', async () => {
    const pluginDir = await writePluginFile(
      tmpDir,
      'bad-plugin',
      `
export const notAPlugin = { foo: 'bar' };
`
    );
    const plugin = await loadPluginFromDirectory(pluginDir);
    expect(plugin).toBeNull();
  });

  it('returns null for a plugin missing register function', async () => {
    const pluginDir = await writePluginFile(
      tmpDir,
      'no-register',
      `
export const plugin = {
  metadata: { id: 'no-register', name: 'No Register', version: '1.0.0', description: '' },
};
`
    );
    const plugin = await loadPluginFromDirectory(pluginDir);
    expect(plugin).toBeNull();
  });

  it('returns null for a plugin missing metadata', async () => {
    const pluginDir = await writePluginFile(
      tmpDir,
      'no-meta',
      `
export const plugin = {
  register: async () => {},
};
`
    );
    const plugin = await loadPluginFromDirectory(pluginDir);
    expect(plugin).toBeNull();
  });
});

describe('loadTrustedPlugins / saveTrustedPlugin', () => {
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when no trust file exists', async () => {
    const trusted = await loadTrustedPlugins();
    expect(trusted).toEqual({});
  });

  it('saves and loads a trusted plugin entry', async () => {
    const pluginPath = '/some/project/.drone-agent/plugins/my-plugin';
    await saveTrustedPlugin(pluginPath, 'trusted');
    const trusted = await loadTrustedPlugins();
    expect(trusted[pluginPath]).toBe('trusted');
  });

  it('saves and loads an untrusted plugin entry', async () => {
    const pluginPath = '/some/project/.drone-agent/plugins/bad-plugin';
    await saveTrustedPlugin(pluginPath, 'untrusted');
    const trusted = await loadTrustedPlugins();
    expect(trusted[pluginPath]).toBe('untrusted');
  });

  it('overwrites existing entries', async () => {
    const pluginPath = '/some/project/.drone-agent/plugins/my-plugin';
    await saveTrustedPlugin(pluginPath, 'untrusted');
    await saveTrustedPlugin(pluginPath, 'trusted');
    const trusted = await loadTrustedPlugins();
    expect(trusted[pluginPath]).toBe('trusted');
  });

  it('preserves multiple entries', async () => {
    await saveTrustedPlugin('/path/a', 'trusted');
    await saveTrustedPlugin('/path/b', 'untrusted');
    await saveTrustedPlugin('/path/c', 'trusted');
    const trusted = await loadTrustedPlugins();
    expect(Object.keys(trusted)).toHaveLength(3);
    expect(trusted['/path/a']).toBe('trusted');
    expect(trusted['/path/b']).toBe('untrusted');
    expect(trusted['/path/c']).toBe('trusted');
  });

  it('filters out invalid entries from corrupt file', async () => {
    const trustDir = path.join(tmpDir, '.drone-agent');
    await mkdir(trustDir, { recursive: true });
    await writeFile(
      path.join(trustDir, 'trusted-plugins.json'),
      JSON.stringify({
        '/valid/trusted': 'trusted',
        '/valid/untrusted': 'untrusted',
        '/invalid/unknown': 'unknown',
        '/invalid/number': 42,
      }),
      'utf-8'
    );
    const trusted = await loadTrustedPlugins();
    expect(trusted['/valid/trusted']).toBe('trusted');
    expect(trusted['/valid/untrusted']).toBe('untrusted');
    expect(trusted['/invalid/unknown']).toBeUndefined();
    expect(trusted['/invalid/number']).toBeUndefined();
  });
});

describe('discoverExternalPlugins', () => {
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    projectDir = await createTempDir();
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('returns empty results when no plugin directories exist', async () => {
    const result = await discoverExternalPlugins(projectDir);
    expect(result.userPlugins).toHaveLength(0);
    expect(result.projectPlugins).toHaveLength(0);
    expect(result.deferredProjectPlugins).toHaveLength(0);
  });

  it('discovers user-scope plugins', async () => {
    // Create user plugin dir (under HOME which is tmpDir)
    const userPluginsDir = path.join(tmpDir, '.drone-agent', 'plugins');
    await writePluginFile(
      userPluginsDir,
      'user-plugin',
      makeValidPluginSource('user-plugin', 'user-tool')
    );

    const result = await discoverExternalPlugins(projectDir);
    expect(result.userPlugins).toHaveLength(1);
    expect(result.userPlugins[0].metadata.id).toBe('user-plugin');
    expect(result.projectPlugins).toHaveLength(0);
    expect(result.deferredProjectPlugins).toHaveLength(0);
  });

  it('discovers project-scope plugins as deferred when no trust decision', async () => {
    // Create project plugin dir
    const projectPluginsDir = path.join(projectDir, '.drone-agent', 'plugins');
    await writePluginFile(
      projectPluginsDir,
      'project-plugin',
      makeValidPluginSource('project-plugin', 'project-tool')
    );

    const result = await discoverExternalPlugins(projectDir);
    expect(result.userPlugins).toHaveLength(0);
    expect(result.projectPlugins).toHaveLength(0);
    expect(result.deferredProjectPlugins).toHaveLength(1);
    expect(result.deferredProjectPlugins[0].plugin.metadata.id).toBe(
      'project-plugin'
    );
  });

  it('loads trusted project plugins immediately', async () => {
    const projectPluginsDir = path.join(projectDir, '.drone-agent', 'plugins');
    const pluginDir = await writePluginFile(
      projectPluginsDir,
      'trusted-plugin',
      makeValidPluginSource('trusted-plugin', 'trusted-tool')
    );

    // Pre-trust the plugin
    await saveTrustedPlugin(pluginDir, 'trusted');

    const result = await discoverExternalPlugins(projectDir);
    expect(result.userPlugins).toHaveLength(0);
    expect(result.projectPlugins).toHaveLength(1);
    expect(result.projectPlugins[0].metadata.id).toBe('trusted-plugin');
    expect(result.deferredProjectPlugins).toHaveLength(0);
  });

  it('skips untrusted project plugins silently', async () => {
    const projectPluginsDir = path.join(projectDir, '.drone-agent', 'plugins');
    const pluginDir = await writePluginFile(
      projectPluginsDir,
      'untrusted-plugin',
      makeValidPluginSource('untrusted-plugin', 'untrusted-tool')
    );

    // Pre-untrust the plugin
    await saveTrustedPlugin(pluginDir, 'untrusted');

    const result = await discoverExternalPlugins(projectDir);
    expect(result.userPlugins).toHaveLength(0);
    expect(result.projectPlugins).toHaveLength(0);
    expect(result.deferredProjectPlugins).toHaveLength(0);
  });

  it('handles mixed trust states correctly', async () => {
    const projectPluginsDir = path.join(projectDir, '.drone-agent', 'plugins');

    // Trusted
    const trustedDir = await writePluginFile(
      projectPluginsDir,
      'trusted-one',
      makeValidPluginSource('trusted-one', 't1')
    );
    await saveTrustedPlugin(trustedDir, 'trusted');

    // Untrusted
    const untrustedDir = await writePluginFile(
      projectPluginsDir,
      'untrusted-one',
      makeValidPluginSource('untrusted-one', 'u1')
    );
    await saveTrustedPlugin(untrustedDir, 'untrusted');

    // Unknown (no trust decision)
    await writePluginFile(
      projectPluginsDir,
      'unknown-one',
      makeValidPluginSource('unknown-one', 'x1')
    );

    const result = await discoverExternalPlugins(projectDir);
    expect(result.projectPlugins).toHaveLength(1);
    expect(result.projectPlugins[0].metadata.id).toBe('trusted-one');
    expect(result.deferredProjectPlugins).toHaveLength(1);
    expect(result.deferredProjectPlugins[0].plugin.metadata.id).toBe(
      'unknown-one'
    );
  });

  it('uses configDir override for user plugins', async () => {
    const customConfigDir = path.join(tmpDir, 'custom-config');
    const userPluginsDir = path.join(
      customConfigDir,
      '.drone-agent',
      'plugins'
    );
    await writePluginFile(
      userPluginsDir,
      'custom-user-plugin',
      makeValidPluginSource('custom-user-plugin', 'custom-tool')
    );

    const result = await discoverExternalPlugins(projectDir, customConfigDir);
    expect(result.userPlugins).toHaveLength(1);
    expect(result.userPlugins[0].metadata.id).toBe('custom-user-plugin');
  });
});

describe('engine.addExternalPlugin', () => {
  it('adds a plugin and makes its tools available', async () => {
    const tool: DroneToolDefinition = {
      name: 'ext-ping',
      description: 'external ping tool',
      inputSchema: { type: 'object', additionalProperties: false },
      execute: async () => 'ext-pong',
    };

    const externalPlugin: DronePlugin = {
      metadata: {
        id: 'external-test',
        name: 'External Test',
        version: '1.0.0',
        description: 'An externally loaded test plugin',
      },
      register: async registration => {
        registration.registerTool(tool);
      },
    };

    const engine = createDronePluginEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();

    // Tool not available before adding
    expect(engine.getTool('external-test__ext-ping')).toBeUndefined();

    // Add the external plugin
    const result = await engine.addExternalPlugin(externalPlugin);
    expect(result).toBe(true);

    // Tool should now be available
    expect(engine.getTool('external-test__ext-ping')).toBeDefined();
    const output = await engine.executeTool('external-test__ext-ping', {});
    expect(output).toBe('ext-pong');
  });

  it('returns false for duplicate plugin IDs', async () => {
    const externalPlugin: DronePlugin = {
      metadata: {
        id: 'dup-plugin',
        name: 'Dup',
        version: '1.0.0',
        description: '',
      },
      register: async () => {},
    };

    const engine = createDronePluginEngine({
      plugins: [externalPlugin],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();

    // Try adding the same ID again
    const result = await engine.addExternalPlugin(externalPlugin);
    expect(result).toBe(false);
  });

  it('runs lifecycle hooks when adding', async () => {
    const calls: string[] = [];

    const externalPlugin: DronePlugin = {
      metadata: {
        id: 'late-hooks',
        name: 'Late Hooks',
        version: '1.0.0',
        description: '',
      },
      register: async registration => {
        registration.hooks.onPluginsLoaded(async () => {
          calls.push('loaded');
        });
        registration.hooks.onSessionStart(async () => {
          calls.push('start');
        });
      },
    };

    const engine = createDronePluginEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();

    // Run hooks first to set the baseline
    await engine.runHooks('onPluginsLoaded');
    await engine.runHooks('onSessionStart');
    expect(calls).toEqual([]);

    // Add plugin — hooks should fire
    await engine.addExternalPlugin(externalPlugin);
    expect(calls).toEqual(['loaded', 'start']);
  });

  it('registers workflows when adding', async () => {
    const externalPlugin: DronePlugin = {
      metadata: {
        id: 'ext-wf',
        name: 'Ext WF',
        version: '1.0.0',
        description: '',
      },
      register: async registration => {
        registration.registerWorkflow({
          name: 'setup',
          description: 'Setup workflow',
          inputSchema: { type: 'object', additionalProperties: false },
          run: async () => ({ toolResult: 'done' }),
        });
      },
    };

    const engine = createDronePluginEngine({
      plugins: [],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });
    await engine.initialize();

    // Workflow not available before adding
    await expect(engine.runWorkflow('ext-wf__setup', {})).rejects.toThrow(
      /Unknown workflow/
    );

    // Add plugin
    await engine.addExternalPlugin(externalPlugin);

    // Workflow should now be registered (will throw about missing elicitation, not unknown)
    try {
      await engine.runWorkflow('ext-wf__setup', {});
    } catch (err) {
      expect((err as Error).message).not.toMatch(/Unknown workflow/);
    }
  });
});
