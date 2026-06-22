import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDefaultAgentConfig,
  type DronePlugin,
} from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { selfImprovementPlugin } from '../src/plugins/self-improvement/index.js';
import { createTestPlugin, silentLogger } from './helpers.js';

function insightFilePath(projectDir: string, targetType: string, targetId: string): string {
  return path.join(projectDir, '.drone-agent', 'insights', targetType, `${targetId}.json`);
}

describe('self-improvement plugin', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `self-improvement-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    // Change cwd to tmpDir so insights are written there
    process.chdir(tmpDir);
  });

  afterEach(async () => {
    process.chdir('/');
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Helper: create an engine with the self-improvement plugin and optional
  // persona/skills plugins.
  async function createEngine(options?: {
    personaCapability?: unknown;
    skillsCapability?: unknown;
  }): Promise<ReturnType<typeof createDronePluginEngine>> {
    const plugins: DronePlugin[] = [selfImprovementPlugin];

    if (options?.personaCapability !== undefined) {
      plugins.push(
        createTestPlugin({
          id: 'persona',
          defaultEnabled: true,
          capability: options.personaCapability,
        })
      );
    }

    if (options?.skillsCapability !== undefined) {
      plugins.push(
        createTestPlugin({
          id: 'skills',
          defaultEnabled: true,
          capability: options.skillsCapability,
        })
      );
    }

    const enabledPlugins = ['self-improvement'];
    if (options?.personaCapability !== undefined) {
      enabledPlugins.push('persona');
    }
    if (options?.skillsCapability !== undefined) {
      enabledPlugins.push('skills');
    }

    const engine = createDronePluginEngine({
      plugins,
      config: { ...createDefaultAgentConfig(), enabledPlugins },
      logger: silentLogger(),
    });

    await engine.initialize();
    return engine;
  }

  it('registers the self-improvement.insight tool', async () => {
    const engine = await createEngine();
    const tools = engine.listTools();
    const insightTool = tools.find(t => t.name === 'self-improvement.insight');
    expect(insightTool).toBeDefined();
    expect(insightTool!.description).toContain('insight');
    expect(insightTool!.inputSchema).toBeDefined();
    expect(insightTool!.inputSchema!.required).toContain('targetType');
    expect(insightTool!.inputSchema!.required).toContain('targetId');
    expect(insightTool!.inputSchema!.required).toContain('insight');
  });

  it('writes an insight for a persona', async () => {
    const personaCap = {
      getPersonas: () => [
        { id: 'coder', name: 'Coder', description: 'A coding persona' },
      ],
      getActivePersona: () => null,
      selectPersona: () => {},
      onPersonaChange: () => {},
      reloadPersonas: async () => {},
    };

    const engine = await createEngine({ personaCapability: personaCap });

    const result = await engine.executeTool('self-improvement.insight', {
      targetType: 'persona',
      targetId: 'coder',
      insight: 'The coder persona could benefit from more concise system prompts.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.targetType).toBe('persona');
    expect(parsed.targetId).toBe('coder');
    expect(parsed.entryCount).toBe(1);

    // Verify the file was written
    const filePath = insightFilePath(tmpDir, 'persona', 'coder');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(1);
    expect(entries[0].insight).toBe(
      'The coder persona could benefit from more concise system prompts.'
    );
    expect(entries[0].timestamp).toBeDefined();
  });

  it('writes an insight for a skill', async () => {
    const skillsCap = {
      getSkills: () => [
        { id: 'testing', name: 'Testing', description: 'Testing skill', recall: [], modelInvocation: true, body: '...', source: 'project' as const },
      ],
      getSkill: (id: string) =>
        id === 'testing'
          ? { id: 'testing', name: 'Testing', description: 'Testing skill', recall: [], modelInvocation: true, body: '...', source: 'project' as const }
          : undefined,
    };

    const engine = await createEngine({ skillsCapability: skillsCap });

    const result = await engine.executeTool('self-improvement.insight', {
      targetType: 'skill',
      targetId: 'testing',
      insight: 'The testing skill should include Playwright examples.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.targetType).toBe('skill');
    expect(parsed.targetId).toBe('testing');
    expect(parsed.entryCount).toBe(1);

    const filePath = insightFilePath(tmpDir, 'skill', 'testing');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].insight).toBe(
      'The testing skill should include Playwright examples.'
    );
  });

  it('appends to an existing insights file', async () => {
    const personaCap = {
      getPersonas: () => [
        { id: 'reviewer', name: 'Reviewer', description: 'A review persona' },
      ],
      getActivePersona: () => null,
      selectPersona: () => {},
      onPersonaChange: () => {},
      reloadPersonas: async () => {},
    };

    const engine = await createEngine({ personaCapability: personaCap });

    // First insight
    await engine.executeTool('self-improvement.insight', {
      targetType: 'persona',
      targetId: 'reviewer',
      insight: 'First insight.',
    });

    // Second insight
    const result = await engine.executeTool('self-improvement.insight', {
      targetType: 'persona',
      targetId: 'reviewer',
      insight: 'Second insight.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.entryCount).toBe(2);

    const filePath = insightFilePath(tmpDir, 'persona', 'reviewer');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].insight).toBe('First insight.');
    expect(entries[1].insight).toBe('Second insight.');
  });

  it('rejects invalid targetType', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement.insight', {
        targetType: 'invalid',
        targetId: 'foo',
        insight: 'Some insight.',
      })
    ).rejects.toThrow(/Invalid targetType/);
  });

  it('rejects empty targetId', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement.insight', {
        targetType: 'persona',
        targetId: '',
        insight: 'Some insight.',
      })
    ).rejects.toThrow(/targetId must be a non-empty string/);
  });

  it('rejects empty insight', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement.insight', {
        targetType: 'persona',
        targetId: 'foo',
        insight: '',
      })
    ).rejects.toThrow(/insight must be a non-empty string/);
  });

  it('rejects unknown persona when persona plugin is loaded', async () => {
    const personaCap = {
      getPersonas: () => [
        { id: 'coder', name: 'Coder', description: 'A coding persona' },
      ],
      getActivePersona: () => null,
      selectPersona: () => {},
      onPersonaChange: () => {},
      reloadPersonas: async () => {},
    };

    const engine = await createEngine({ personaCapability: personaCap });

    await expect(
      engine.executeTool('self-improvement.insight', {
        targetType: 'persona',
        targetId: 'nonexistent',
        insight: 'Some insight.',
      })
    ).rejects.toThrow(/Unknown persona/);
  });

  it('rejects unknown skill when skills plugin is loaded', async () => {
    const skillsCap = {
      getSkills: () => [],
      getSkill: () => undefined,
    };

    const engine = await createEngine({ skillsCapability: skillsCap });

    await expect(
      engine.executeTool('self-improvement.insight', {
        targetType: 'skill',
        targetId: 'nonexistent',
        insight: 'Some insight.',
      })
    ).rejects.toThrow(/Unknown skill/);
  });

  it('works without persona or skills plugins loaded', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool('self-improvement.insight', {
      targetType: 'persona',
      targetId: 'any-persona',
      insight: 'Works without validation.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.targetType).toBe('persona');
    expect(parsed.targetId).toBe('any-persona');
    expect(parsed.entryCount).toBe(1);

    // Verify the file was written
    const filePath = insightFilePath(tmpDir, 'persona', 'any-persona');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].insight).toBe('Works without validation.');
  });

  it('lowercases targetId', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool('self-improvement.insight', {
      targetType: 'skill',
      targetId: 'My-Skill-Name',
      insight: 'Lowercase test.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.targetId).toBe('my-skill-name');

    const filePath = insightFilePath(tmpDir, 'skill', 'my-skill-name');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(1);
  });

  describe('project insights', () => {
    it('writes a project insight to .drone-agent/insights/project/<targetId>.json', async () => {
      const engine = await createEngine();

      const result = await engine.executeTool('self-improvement.insight', {
        targetType: 'project',
        targetId: 'architecture',
        insight: 'The plugin architecture should use dependency injection.',
      });

      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.targetType).toBe('project');
      expect(parsed.targetId).toBe('architecture');
      expect(parsed.entryCount).toBe(1);

      const filePath = insightFilePath(tmpDir, 'project', 'architecture');
      const raw = await readFile(filePath, 'utf-8');
      const entries = JSON.parse(raw);
      expect(Array.isArray(entries)).toBe(true);
      expect(entries).toHaveLength(1);
      expect(entries[0].insight).toBe('The plugin architecture should use dependency injection.');
      expect(entries[0].timestamp).toBeDefined();
    });

    it('appends to an existing project insights file', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.insight', {
        targetType: 'project',
        targetId: 'workflow',
        insight: 'First insight.',
      });

      const result = await engine.executeTool('self-improvement.insight', {
        targetType: 'project',
        targetId: 'workflow',
        insight: 'Second insight.',
      });

      const parsed = JSON.parse(result);
      expect(parsed.entryCount).toBe(2);

      const filePath = insightFilePath(tmpDir, 'project', 'workflow');
      const raw = await readFile(filePath, 'utf-8');
      const entries = JSON.parse(raw);
      expect(entries).toHaveLength(2);
      expect(entries[0].insight).toBe('First insight.');
      expect(entries[1].insight).toBe('Second insight.');
    });

    it('rejects empty targetId for project insights', async () => {
      const engine = await createEngine();

      await expect(
        engine.executeTool('self-improvement.insight', {
          targetType: 'project',
          targetId: '',
          insight: 'Some insight.',
        })
      ).rejects.toThrow(/targetId must be a non-empty string/);
    });

    it('rejects empty insight for project insights', async () => {
      const engine = await createEngine();

      await expect(
        engine.executeTool('self-improvement.insight', {
          targetType: 'project',
          targetId: 'testing',
          insight: '',
        })
      ).rejects.toThrow(/insight must be a non-empty string/);
    });

    it('works without persona or skills plugins loaded', async () => {
      const engine = await createEngine();

      const result = await engine.executeTool('self-improvement.insight', {
        targetType: 'project',
        targetId: 'testing',
        insight: 'Works without validation.',
      });

      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.targetType).toBe('project');
      expect(parsed.targetId).toBe('testing');
      expect(parsed.entryCount).toBe(1);

      const filePath = insightFilePath(tmpDir, 'project', 'testing');
      const raw = await readFile(filePath, 'utf-8');
      const entries = JSON.parse(raw);
      expect(entries).toHaveLength(1);
      expect(entries[0].insight).toBe('Works without validation.');
    });
  });
});
