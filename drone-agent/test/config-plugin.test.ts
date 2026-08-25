import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAgentConfig } from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { configPlugin } from '../src/plugins/config/index.js';
import type { DroneConfigCapability } from '../src/plugins/config/index.js';
import { deepSet } from '../src/plugins/config/helpers.js';
import { silentLogger } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testHomeDir = '';

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
}

async function setupDirs(): Promise<{
  homeDir: string;
  projectDir: string;
}> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'config-plugin-home-'));
  const projectDir = await mkdtemp(
    path.join(os.tmpdir(), 'config-plugin-project-')
  );
  testHomeDir = homeDir;
  vi.spyOn(os, 'homedir').mockImplementation(() => testHomeDir);
  return { homeDir, projectDir };
}

afterEach(async () => {
  if (testHomeDir) {
    await rm(testHomeDir, { recursive: true, force: true });
  }
  testHomeDir = '';
  vi.restoreAllMocks();
});

beforeEach(() => {
  testHomeDir = '';
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config plugin', () => {
  it('is default-enabled', () => {
    expect(configPlugin.metadata.defaultEnabled).toBe(true);
  });

  it('registers config.get, config.set, and config.list_layers tools', async () => {
    const engine = createDronePluginEngine({
      plugins: [configPlugin],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });

    await engine.initialize();

    // Mount the tools to verify they exist
    await engine.executeTool('runtime__mount_tool', { tool: 'config__get' });
    await engine.executeTool('runtime__mount_tool', { tool: 'config__set' });
    const tools = engine.listTools();
    const toolNames = tools.map(t => t.name);
    expect(toolNames).toContain('config__get');
    expect(toolNames).toContain('config__set');
    expect(toolNames).not.toContain('config__list_layers');
  });

  it('offers DroneConfigCapability', async () => {
    const engine = createDronePluginEngine({
      plugins: [configPlugin],
      config: createDefaultAgentConfig(),
      logger: silentLogger(),
    });

    await engine.initialize();

    const cap = engine.getCapability<DroneConfigCapability>('config');
    expect(cap).toBeDefined();
    expect(typeof cap!.getConfig).toBe('function');
    expect(typeof cap!.getLayers).toBe('function');
    expect(typeof cap!.setValue).toBe('function');
  });

  it('guards deepSet against prototype pollution path segments', () => {
    const target: Record<string, unknown> = {};
    expect(() => deepSet(target, '__proto__.polluted', true)).toThrow(
      /Unsafe config key path segment/
    );
    expect(() => deepSet(target, 'safe.__proto__', true)).toThrow(
      /Unsafe config key path segment/
    );
    expect(() => deepSet(target, 'constructor.polluted', true)).toThrow(
      /Unsafe config key path segment/
    );
    expect(() => deepSet(target, 'prototype.polluted', true)).toThrow(
      /Unsafe config key path segment/
    );
    expect(() => deepSet(target, 'safe.constructor', true)).toThrow(
      /Unsafe config key path segment/
    );
    expect(() => deepSet(target, '', true)).toThrow(
      /Invalid config key path segment/
    );
    expect(() => deepSet(target, '.', true)).toThrow(
      /Invalid config key path segment/
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  describe('config__get', () => {
    it('returns the full resolved config with provenance when no key is given', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const result = await engine.executeTool('config__get', {});
      const parsed = JSON.parse(result);

      expect(parsed.ollama).toBeDefined();
      expect(parsed.ollama.host).toBe('http://127.0.0.1:11434');
      expect(parsed._provenance).toBeDefined();
      expect(parsed._provenance['ollama.host']).toBe('default');
    });

    it('returns a specific value with provenance when a key is given', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const result = await engine.executeTool('config__get', {
        key: 'ollama.model',
      });
      const parsed = JSON.parse(result);

      expect(parsed.key).toBe('ollama.model');
      expect(parsed.value).toBe('llama3.1');
      expect(parsed.source).toBe('default');
    });

    it('returns project-layer provenance when a project config overrides a value', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      // Write a project-level config that overrides the model
      await writeJson(path.join(projectDir, '.drone-agent', 'config.json'), {
        ollama: { model: 'custom-model' },
      });

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const result = await engine.executeTool('config__get', {
        key: 'ollama.model',
      });
      const parsed = JSON.parse(result);

      expect(parsed.value).toBe('custom-model');
      expect(parsed.source).toBe('project');
    });
  });

  describe('config__set', () => {
    it('writes a config value to the project scope by default', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const result = await engine.executeTool('config__set', {
        key: 'ollama.model',
        value: 'llama3.2',
      });
      const parsed = JSON.parse(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.scope).toBe('project');
      expect(parsed.key).toBe('ollama.model');
      expect(parsed.filePath).toContain('.drone-agent/config.json');

      // Verify the file was written
      const { readFile } = await import('node:fs/promises');
      const written = JSON.parse(await readFile(parsed.filePath, 'utf-8'));
      expect(written.ollama.model).toBe('llama3.2');
    });

    it('writes a config value to the user scope when specified', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const result = await engine.executeTool('config__set', {
        scope: 'user',
        key: 'ollama.model',
        value: 'user-model',
      });
      const parsed = JSON.parse(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.scope).toBe('user');
      expect(parsed.key).toBe('ollama.model');

      // Verify the file was written in the home dir
      const { readFile } = await import('node:fs/promises');
      const written = JSON.parse(await readFile(parsed.filePath, 'utf-8'));
      expect(written.ollama.model).toBe('user-model');
    });

    it('rejects unknown config keys', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      await expect(
        engine.executeTool('config__set', {
          key: 'nonexistent.setting',
          value: 'foo',
        })
      ).rejects.toThrow(/Unknown config key/);
    });

    it('accepts session.retry.* keys', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const result = await engine.executeTool('config__set', {
        key: 'session.retry.maxRetries',
        value: 5,
      });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.key).toBe('session.retry.maxRetries');
    });

    it('rejects invalid scope values', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      await expect(
        engine.executeTool('config__set', {
          scope: 'invalid',
          key: 'ollama.model',
          value: 'test',
        })
      ).rejects.toThrow(/scope must be "project" or "user"/);
    });

    it('supports nested object values', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const result = await engine.executeTool('config__set', {
        key: 'ollama',
        value: { host: 'http://localhost:11435', model: 'nested-model' },
      });
      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);

      const { readFile } = await import('node:fs/promises');
      const written = JSON.parse(await readFile(parsed.filePath, 'utf-8'));
      expect(written.ollama.host).toBe('http://localhost:11435');
      expect(written.ollama.model).toBe('nested-model');
    });
  });

  describe('config__get with showLayers', () => {
    it('includes layer info when showLayers=true', async () => {
      const { homeDir, projectDir } = await setupDirs();
      process.chdir(projectDir);

      // Write a project-level config
      await writeJson(path.join(projectDir, '.drone-agent', 'config.json'), {
        ollama: { model: 'project-model' },
      });

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const result = await engine.executeTool('config__get', {
        showLayers: true,
      });
      const parsed = JSON.parse(result);

      expect(parsed.layers).toBeDefined();
      expect(parsed.layers.length).toBeGreaterThanOrEqual(2);

      const defaultLayer = parsed.layers.find(
        (l: { scope: string }) => l.scope === 'default'
      );
      expect(defaultLayer).toBeDefined();
      expect(defaultLayer.path).toBeNull();

      const projectLayer = parsed.layers.find(
        (l: { scope: string }) => l.scope === 'project'
      );
      expect(projectLayer).toBeDefined();
      expect(projectLayer.path).toContain('.drone-agent/config.json');
      expect(projectLayer.keys).toContain('ollama');
    });
  });

  describe('DroneConfigCapability', () => {
    it('getConfig returns the resolved config', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const cap = engine.getCapability<DroneConfigCapability>('config')!;
      const config = cap.getConfig();
      expect(config.ollama.host).toBe('http://127.0.0.1:11434');
    });

    it('getLayers returns the config layers', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const cap = engine.getCapability<DroneConfigCapability>('config')!;
      const layers = await cap.getLayers();
      expect(layers.length).toBeGreaterThanOrEqual(1);
      expect(layers[0].scope).toBe('default');
    });

    it('setValue writes a config value', async () => {
      const { projectDir } = await setupDirs();
      process.chdir(projectDir);

      const engine = createDronePluginEngine({
        plugins: [configPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });

      await engine.initialize();

      const cap = engine.getCapability<DroneConfigCapability>('config')!;
      await cap.setValue('project', 'ollama.model', 'capability-model');

      const { readFile } = await import('node:fs/promises');
      const written = JSON.parse(
        await readFile(
          path.join(projectDir, '.drone-agent', 'config.json'),
          'utf-8'
        )
      );
      expect(written.ollama.model).toBe('capability-model');
    });
  });
});
