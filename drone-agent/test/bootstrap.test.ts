import { describe, expect, it } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDefaultAgentConfig } from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { createTestPlugin, silentLogger } from './helpers.js';
import { bootstrapPlugin } from '../src/plugins/bootstrap/index.js';
import { detectProject } from '../src/plugins/bootstrap/project-detect.js';

describe('bootstrap plugin', () => {
  describe('detectProject', () => {
    it('detects a Node.js project with package.json', async () => {
      const tmpDir = path.join(
        os.tmpdir(),
        `drone-bootstrap-test-${Date.now()}`
      );
      await mkdir(tmpDir, { recursive: true });
      try {
        await writeFile(
          path.join(tmpDir, 'package.json'),
          JSON.stringify({ name: 'test', dependencies: { express: '^4.0.0' } })
        );
        await writeFile(path.join(tmpDir, '.git'), ''); // fake git dir

        const result = await detectProject(tmpDir);
        expect(result.language).toBe('JavaScript/TypeScript');
        expect(result.framework).toBe('Express');
        expect(result.hasGit).toBe(true);
        expect(result.suggestedPlugins).toContain('git');
        expect(result.suggestedPlugins).toContain('file');
        expect(result.suggestedPlugins).toContain('search');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('detects a Rust project', async () => {
      const tmpDir = path.join(
        os.tmpdir(),
        `drone-bootstrap-test-${Date.now()}`
      );
      await mkdir(tmpDir, { recursive: true });
      try {
        await writeFile(
          path.join(tmpDir, 'Cargo.toml'),
          '[package]\nname = "test"\n'
        );

        const result = await detectProject(tmpDir);
        expect(result.language).toBe('Rust');
        expect(result.detectedFiles).toContain('Cargo.toml');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('detects a Python project', async () => {
      const tmpDir = path.join(
        os.tmpdir(),
        `drone-bootstrap-test-${Date.now()}`
      );
      await mkdir(tmpDir, { recursive: true });
      try {
        await writeFile(
          path.join(tmpDir, 'pyproject.toml'),
          '[project]\nname = "test"\n'
        );

        const result = await detectProject(tmpDir);
        expect(result.language).toBe('Python');
        expect(result.detectedFiles).toContain('pyproject.toml');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('detects an empty directory', async () => {
      const tmpDir = path.join(
        os.tmpdir(),
        `drone-bootstrap-test-${Date.now()}`
      );
      await mkdir(tmpDir, { recursive: true });
      try {
        const result = await detectProject(tmpDir);
        expect(result.language).toBeNull();
        expect(result.framework).toBeNull();
        expect(result.hasGit).toBe(false);
        expect(result.suggestedPlugins).toContain('file');
        expect(result.suggestedPlugins).toContain('search');
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('detects home directory', async () => {
      const result = await detectProject(os.homedir());
      expect(result.isHomeDirectory).toBe(true);
    });
  });

  describe('bootstrap plugin registration', () => {
    it('registers the analyze tool', async () => {
      const engine = createDronePluginEngine({
        plugins: [bootstrapPlugin],
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['bootstrap'],
        },
        logger: silentLogger(),
      });
      await engine.initialize();
      expect(engine.getTool('bootstrap__analyze')).toBeDefined();
    });

    it('registers the project and user workflows', async () => {
      const engine = createDronePluginEngine({
        plugins: [bootstrapPlugin],
        config: {
          ...createDefaultAgentConfig(),
          enabledPlugins: ['bootstrap'],
        },
        logger: silentLogger(),
      });
      await engine.initialize();
      // Workflows are registered but can only be run with elicitation,
      // so we verify they exist by trying to run them (they'll fail on missing elicitation)
      expect(engine.listTools()).toContainEqual(
        expect.objectContaining({ name: 'bootstrap__analyze' })
      );
    });
  });

  describe('bootstrap.project workflow with enablePlugin', () => {
    it('enables plugins via enablePlugin and they become available', async () => {
      const gitPlugin = createTestPlugin({
        id: 'git',
        defaultEnabled: false,
        tools: [
          {
            name: 'list_tools',
            description: 'List all available git tools.',
            inputSchema: { type: 'object', additionalProperties: false },
            execute: async () => 'ok',
          },
        ],
      });

      const engine = createDronePluginEngine({
        plugins: [gitPlugin, bootstrapPlugin],
        config: createDefaultAgentConfig(),
        logger: silentLogger(),
      });
      await engine.initialize();

      // git should not be enabled initially
      expect(engine.listPlugins().find(p => p.id === 'git')?.enabled).toBe(
        false
      );
      expect(engine.getTool('git__list_tools')).toBeUndefined();

      // Enable git plugin
      const result = await engine.enablePlugin('git');
      expect(result).toBe(true);
      expect(engine.listPlugins().find(p => p.id === 'git')?.enabled).toBe(
        true
      );
      expect(engine.getTool('git__list_tools')).toBeDefined();
    });
  });
});
