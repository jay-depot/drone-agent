import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  createDefaultAgentConfig,
  toToolResultContent,
  type DronePlugin,
} from 'drone-core';
import { createDronePluginEngine } from '../../src/runtime/plugin-engine.js';
import { selfImprovementPlugin } from '../../src/plugins/self-improvement/index.js';
import { createTestPlugin, silentLogger } from '../helpers.js';
import { principleFilePath, createEngine } from './setup.js';

describe('self-improvement__principle (store action)', () => {
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

  it('stores a principle for a project', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'architecture',
      principle: 'Always use dependency injection.',
      source: 'Derived from insights',
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.targetType).toBe('project');
    expect(parsed.targetId).toBe('architecture');
    expect(parsed.principleCount).toBe(1);

    const filePath = principleFilePath(tmpDir, 'project', 'architecture');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].principle).toBe('Always use dependency injection.');
    expect(entries[0].source).toBe('Derived from insights');
    expect(entries[0].createdAt).toBeDefined();
  });

  it('stores a principle for a persona', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'persona',
      targetId: 'coder',
      principle: 'Be concise in responses.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.targetType).toBe('persona');
    expect(parsed.targetId).toBe('coder');

    const filePath = principleFilePath(tmpDir, 'persona', 'coder');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].principle).toBe('Be concise in responses.');
  });

  it('stores a principle for a skill', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'skill',
      targetId: 'testing',
      principle: 'Always include edge cases.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.targetType).toBe('skill');
    expect(parsed.targetId).toBe('testing');

    const filePath = principleFilePath(tmpDir, 'skill', 'testing');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].principle).toBe('Always include edge cases.');
  });

  it('appends to existing principles', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'workflow',
      principle: 'First principle.',
    });

    const result = await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'workflow',
      principle: 'Second principle.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.principleCount).toBe(2);

    const filePath = principleFilePath(tmpDir, 'project', 'workflow');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].principle).toBe('First principle.');
    expect(entries[1].principle).toBe('Second principle.');
  });

  it('rejects empty principle text', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__principle', {
        action: 'store',
        targetType: 'project',
        targetId: 'test',
        principle: '',
      })
    ).rejects.toThrow(/principle must be a non-empty string/);
  });

  it('rejects omitted targetId on store', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__principle', {
        action: 'store',
        targetType: 'project',
        principle: 'A principle.',
      })
    ).rejects.toThrow(/targetId must be a non-empty string/);
  });

  it('rejects omitted principle on store', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__principle', {
        action: 'store',
        targetType: 'project',
        targetId: 'test',
      })
    ).rejects.toThrow(/principle must be a non-empty string/);
  });

  it('rejects invalid targetType', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__principle', {
        action: 'store',
        targetType: 'invalid',
        targetId: 'test',
        principle: 'A principle.',
      })
    ).rejects.toThrow(/Invalid targetType/);
  });

  it('stores a principle without source', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'test',
      principle: 'No source principle.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);

    const filePath = principleFilePath(tmpDir, 'project', 'test');
    const raw = await readFile(filePath, 'utf-8');
    const entries = JSON.parse(raw);
    expect(entries[0].source).toBeUndefined();
  });
});

describe('self-improvement__principle (list action)', () => {
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

  it('returns empty list when no principles exist', async () => {
    const engine = await createEngine();
    const result = await engine.executeTool('self-improvement__principle', {
      action: 'list',
    });
    const parsed = JSON.parse(result);
    expect(parsed.principles).toEqual([]);
  });

  it('lists all principle files', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'arch',
      principle: 'Principle one.',
    });
    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'skill',
      targetId: 'test',
      principle: 'Principle two.',
    });

    const result = await engine.executeTool('self-improvement__principle', {
      action: 'list',
    });
    const parsed = JSON.parse(result);
    expect(parsed.principles).toHaveLength(2);
  });

  it('filters by targetType', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'arch',
      principle: 'Project principle.',
    });
    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'skill',
      targetId: 'test',
      principle: 'Skill principle.',
    });

    const result = await engine.executeTool('self-improvement__principle', {
      action: 'list',
      targetType: 'project',
    });
    const parsed = JSON.parse(result);
    expect(parsed.principles).toHaveLength(1);
    expect(parsed.principles[0].targetType).toBe('project');
  });
});

describe('self-improvement__principle (recall action)', () => {
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

  it('returns principles for a valid target', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'testing',
      principle: 'Principle one.',
    });
    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'testing',
      principle: 'Principle two.',
    });

    const result = await engine.executeTool('self-improvement__principle', {
      action: 'recall',
      targetType: 'project',
      targetId: 'testing',
    });
    const parsed = JSON.parse(result);
    expect(parsed.targetType).toBe('project');
    expect(parsed.targetId).toBe('testing');
    expect(parsed.principles).toHaveLength(2);
    expect(parsed.principles[0].principle).toBe('Principle one.');
    expect(parsed.principles[1].principle).toBe('Principle two.');
  });

  it('returns empty array when no principles exist', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool('self-improvement__principle', {
      action: 'recall',
      targetType: 'project',
      targetId: 'nonexistent',
    });
    const parsed = JSON.parse(result);
    expect(parsed.principles).toEqual([]);
  });

  it('rejects invalid targetType', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__principle', {
        action: 'recall',
        targetType: 'invalid',
        targetId: 'foo',
      })
    ).rejects.toThrow(/Invalid targetType/);
  });
});

describe('self-improvement__principle (delete action)', () => {
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

  it('deletes a principle by index', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'test',
      principle: 'Keep me.',
    });
    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'test',
      principle: 'Delete me.',
    });

    const result = await engine.executeTool('self-improvement__principle', {
      action: 'delete',
      targetType: 'project',
      targetId: 'test',
      index: 1,
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.remainingCount).toBe(1);

    const recallResult = await engine.executeTool(
      'self-improvement__principle',
      {
        action: 'recall',
        targetType: 'project',
        targetId: 'test',
      }
    );
    const recallParsed = JSON.parse(recallResult);
    expect(recallParsed.principles).toHaveLength(1);
    expect(recallParsed.principles[0].principle).toBe('Keep me.');
  });

  it('rejects out-of-bounds index', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'test',
      principle: 'Only one.',
    });

    await expect(
      engine.executeTool('self-improvement__principle', {
        action: 'delete',
        targetType: 'project',
        targetId: 'test',
        index: 5,
      })
    ).rejects.toThrow(/out of bounds/);
  });

  it('rejects negative index', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__principle', {
        action: 'delete',
        targetType: 'project',
        targetId: 'test',
        index: -1,
      })
    ).rejects.toThrow(/index must be a non-negative integer/);
  });

  it('rejects omitted targetId on delete', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__principle', {
        action: 'delete',
        targetType: 'project',
        index: 0,
      })
    ).rejects.toThrow(/targetId must be a non-empty string/);
  });

  it('removes the file when last principle is deleted', async () => {
    const engine = await createEngine();

    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'test',
      principle: 'Only one.',
    });

    await engine.executeTool('self-improvement__principle', {
      action: 'delete',
      targetType: 'project',
      targetId: 'test',
      index: 0,
    });

    const filePath = principleFilePath(tmpDir, 'project', 'test');
    await expect(readFile(filePath, 'utf-8')).rejects.toThrow();
  });
});

describe('combined principles prompt fragment', () => {
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

  it('renders project principles when they exist', async () => {
    const engine = await createEngine();

    // Store a project principle
    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'architecture',
      principle: 'Use dependency injection.',
    });

    const fragments = await engine.renderPromptFragments();
    const fragment = fragments.find(f => f.includes('## Current Project'));
    expect(fragment).toBeDefined();
    expect(fragment).toContain('## Current Project');
    expect(fragment).toContain('### architecture');
    expect(fragment).toContain('Use dependency injection.');
  });

  it('renders persona principles when persona is active and has principles', async () => {
    const personaCap = {
      getPersonas: () => [
        { id: 'coder', name: 'Coder', description: 'A coding persona' },
      ],
      getActivePersona: () => ({
        id: 'coder',
        name: 'Coder',
        description: 'A coding persona',
      }),
      selectPersona: () => {},
      onPersonaChange: () => {},
      reloadPersonas: async () => {},
    };

    const engine = await createEngine({ personaCapability: personaCap });

    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'persona',
      targetId: 'coder',
      principle: 'Be concise.',
    });

    const fragments = await engine.renderPromptFragments();
    const fragment = fragments.find(f => f.includes('## Current Persona'));
    expect(fragment).toBeDefined();
    expect(fragment).toContain('## Current Persona');
    expect(fragment).toContain('### coder');
    expect(fragment).toContain('Be concise.');
  });

  it('renders both project and persona principles when both exist', async () => {
    const personaCap = {
      getPersonas: () => [
        { id: 'coder', name: 'Coder', description: 'A coding persona' },
      ],
      getActivePersona: () => ({
        id: 'coder',
        name: 'Coder',
        description: 'A coding persona',
      }),
      selectPersona: () => {},
      onPersonaChange: () => {},
      reloadPersonas: async () => {},
    };

    const engine = await createEngine({ personaCapability: personaCap });

    // Store project principle
    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'workflow',
      principle: 'Confirm destructive operations.',
    });

    // Store persona principle
    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'persona',
      targetId: 'coder',
      principle: 'Be concise.',
    });

    const fragments = await engine.renderPromptFragments();
    const fragment = fragments.find(
      f => f.includes('## Current Project') && f.includes('## Current Persona')
    );
    expect(fragment).toBeDefined();
    expect(fragment).toContain('## Current Project');
    expect(fragment).toContain('### workflow');
    expect(fragment).toContain('Confirm destructive operations.');
    expect(fragment).toContain('## Current Persona');
    expect(fragment).toContain('### coder');
    expect(fragment).toContain('Be concise.');
  });

  it('returns false when no principles exist', async () => {
    const engine = await createEngine();

    const fragments = await engine.renderPromptFragments();
    const fragment = fragments.find(
      f => f.includes('## Current Project') || f.includes('## Current Persona')
    );
    expect(fragment).toBeUndefined();
  });

  it('returns false when no persona is active', async () => {
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

    // Store a project principle to test it still renders without active persona
    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'project',
      targetId: 'architecture',
      principle: 'Use dependency injection.',
    });

    const fragments = await engine.renderPromptFragments();
    const fragment = fragments.find(f => f.includes('## Current Project'));
    expect(fragment).toBeDefined();
    expect(fragment).toContain('## Current Project');
    expect(fragment).not.toContain('## Current Persona');
  });
});

describe('skill principles injection', () => {
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

  it('injects principles into skills.recall result when self-improvement is loaded', async () => {
    // Mock skills plugin that uses onRecall callback
    const recallEnhancers: Array<
      (id: string, body: string) => Promise<string>
    > = [];

    const mockSkillsPlugin = createTestPlugin({
      id: 'skills',
      register: reg => {
        // Register a tool that runs recall enhancers
        reg.registerTool({
          name: 'recall',
          description: 'Mock recall.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Skill id.' },
            },
            required: ['id'],
            additionalProperties: false,
          },
          execute: async input => {
            const id =
              typeof input.id === 'string' ? input.id.trim().toLowerCase() : '';
            let body = 'Original body.';
            for (const enhancer of recallEnhancers) {
              body = await enhancer(id, body);
            }
            return JSON.stringify(
              {
                id,
                name: 'Test',
                description: 'A test skill',
                source: 'project',
                body,
              },
              null,
              2
            );
          },
        });
        // Register full skills capability (including onRecall)
        reg.offer({
          getSkills: () => [
            {
              id: 'test-skill',
              name: 'Test',
              description: 'A test skill',
              source: 'project' as const,
              recall: [],
              modelInvocation: false,
              body: 'Original body.',
            },
          ],
          getSkill: (id: string) =>
            id === 'test-skill'
              ? {
                  id: 'test-skill',
                  name: 'Test',
                  description: 'A test skill',
                  source: 'project' as const,
                  recall: [],
                  modelInvocation: false,
                  body: 'Original body.',
                }
              : undefined,
          reloadSkills: async () => {},
          registerProvider: () => {},
          unregisterProvider: () => {},
          onRecall: (
            enhancer: (id: string, body: string) => Promise<string>
          ) => {
            recallEnhancers.push(enhancer);
          },
        });
      },
    });

    const plugins: DronePlugin[] = [selfImprovementPlugin, mockSkillsPlugin];
    const enabledPlugins = ['self-improvement', 'skills'];

    const engine = createDronePluginEngine({
      plugins,
      config: { ...createDefaultAgentConfig(), enabledPlugins },
      logger: silentLogger(),
    });
    await engine.initialize();
    await engine.runHooks('onPluginsLoaded');

    // The self-improvement plugin should have registered a recall enhancer
    // via the skills capability's onRecall callback

    await engine.executeTool('self-improvement__principle', {
      action: 'store',
      targetType: 'skill',
      targetId: 'test-skill',
      principle: 'Always test edge cases.',
    });

    const result = await engine.executeTool('skills__recall', {
      id: 'test-skill',
    });
    const parsed = JSON.parse(toToolResultContent(result));
    expect(parsed.body).toContain('Original body.');
    expect(parsed.body).toContain('## Principles');
    expect(parsed.body).toContain('Always test edge cases.');
  });

  it('does not inject principles when self-improvement is not loaded', async () => {
    const mockSkillsPlugin = createTestPlugin({
      id: 'skills',
      tools: [
        {
          name: 'recall',
          description: 'Mock recall.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Skill id.' },
            },
            required: ['id'],
            additionalProperties: false,
          },
          execute: async input => {
            const id =
              typeof input.id === 'string' ? input.id.trim().toLowerCase() : '';
            return JSON.stringify(
              {
                id,
                name: 'Test',
                description: 'A test skill',
                source: 'project',
                body: 'Original body.',
              },
              null,
              2
            );
          },
        },
      ],
    });

    const plugins: DronePlugin[] = [mockSkillsPlugin];
    const enabledPlugins = ['skills'];

    const engine = createDronePluginEngine({
      plugins,
      config: { ...createDefaultAgentConfig(), enabledPlugins },
      logger: silentLogger(),
    });
    await engine.initialize();

    const result = await engine.executeTool('skills__recall', {
      id: 'test-skill',
    });
    const parsed = JSON.parse(toToolResultContent(result));
    expect(parsed.body).toBe('Original body.');
    expect(parsed.body).not.toContain('## Principles');
  });

  it('does not add principles section when no principles exist', async () => {
    const recallEnhancers: Array<
      (id: string, body: string) => Promise<string>
    > = [];

    const mockSkillsPlugin = createTestPlugin({
      id: 'skills',
      register: reg => {
        reg.registerTool({
          name: 'recall',
          description: 'Mock recall.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Skill id.' },
            },
            required: ['id'],
            additionalProperties: false,
          },
          execute: async input => {
            const id =
              typeof input.id === 'string' ? input.id.trim().toLowerCase() : '';
            let body = 'Original body.';
            for (const enhancer of recallEnhancers) {
              body = await enhancer(id, body);
            }
            return JSON.stringify(
              {
                id,
                name: 'Test',
                description: 'A test skill',
                source: 'project',
                body,
              },
              null,
              2
            );
          },
        });
        reg.offer({
          getSkills: () => [
            {
              id: 'test-skill',
              name: 'Test',
              description: 'A test skill',
              source: 'project' as const,
              recall: [],
              modelInvocation: false,
              body: 'Original body.',
            },
          ],
          getSkill: (id: string) =>
            id === 'test-skill'
              ? {
                  id: 'test-skill',
                  name: 'Test',
                  description: 'A test skill',
                  source: 'project' as const,
                  recall: [],
                  modelInvocation: false,
                  body: 'Original body.',
                }
              : undefined,
          reloadSkills: async () => {},
          registerProvider: () => {},
          unregisterProvider: () => {},
          onRecall: (
            enhancer: (id: string, body: string) => Promise<string>
          ) => {
            recallEnhancers.push(enhancer);
          },
        });
      },
    });

    const plugins: DronePlugin[] = [selfImprovementPlugin, mockSkillsPlugin];
    const enabledPlugins = ['self-improvement', 'skills'];

    const engine = createDronePluginEngine({
      plugins,
      config: { ...createDefaultAgentConfig(), enabledPlugins },
      logger: silentLogger(),
    });
    await engine.initialize();
    await engine.runHooks('onPluginsLoaded');

    const result = await engine.executeTool('skills__recall', {
      id: 'test-skill',
    });
    const parsed = JSON.parse(toToolResultContent(result));
    expect(parsed.body).toBe('Original body.');
    expect(parsed.body).not.toContain('## Principles');
  });
});
