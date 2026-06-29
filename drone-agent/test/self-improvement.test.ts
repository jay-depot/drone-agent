import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os, { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAgentConfig, type DronePlugin } from 'drone-core';
import { createDronePluginEngine } from '../src/runtime/plugin-engine.js';
import { selfImprovementPlugin } from '../src/plugins/self-improvement/index.js';
import { createTestPlugin, silentLogger } from './helpers.js';

function insightFilePath(
  projectDir: string,
  targetType: string,
  targetId: string
): string {
  if (targetType === 'persona') {
    return path.join(
      projectDir,
      '.drone-agent',
      'personas',
      targetId,
      'insights',
      'insights.json'
    );
  }
  return path.join(
    projectDir,
    '.drone-agent',
    'insights',
    targetType,
    `${targetId}.json`
  );
}

function principleFilePath(
  projectDir: string,
  targetType: string,
  targetId: string
): string {
  if (targetType === 'persona') {
    return path.join(
      projectDir,
      '.drone-agent',
      'personas',
      targetId,
      'principles',
      'principles.json'
    );
  }
  return path.join(
    projectDir,
    '.drone-agent',
    'principles',
    targetType,
    `${targetId}.json`
  );
}

function userInsightFilePath(targetType: string, targetId: string): string {
  if (targetType === 'persona') {
    return path.join(
      os.homedir(),
      '.drone-agent',
      'personas',
      targetId,
      'insights',
      'insights.json'
    );
  }
  return path.join(
    os.homedir(),
    '.drone-agent',
    'insights',
    targetType,
    `${targetId}.json`
  );
}

async function withTempHome<T>(
  fn: (homeDir: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'self-improvement-home-'));
  try {
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    return await fn(dir);
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('self-improvement plugin', () => {
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

  it('writes an insight for a project-level persona', async () => {
    const personaCap = {
      getPersonas: () => [
        {
          id: 'coder',
          name: 'Coder',
          description: 'A coding persona',
          scope: 'project' as const,
        },
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
      insight:
        'The coder persona could benefit from more concise system prompts.',
    });

    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.targetType).toBe('persona');
    expect(parsed.targetId).toBe('coder');
    expect(parsed.entryCount).toBe(1);

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

  it('writes an insight for a user-level persona', async () => {
    await withTempHome(async () => {
      const personaCap = {
        getPersonas: () => [
          {
            id: 'helper',
            name: 'Helper',
            description: 'A helper persona',
            scope: 'user' as const,
          },
        ],
        getActivePersona: () => null,
        selectPersona: () => {},
        onPersonaChange: () => {},
        reloadPersonas: async () => {},
      };

      const engine = await createEngine({ personaCapability: personaCap });

      const result = await engine.executeTool('self-improvement.insight', {
        targetType: 'persona',
        targetId: 'helper',
        insight: 'The helper persona should be more concise.',
      });

      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.targetType).toBe('persona');
      expect(parsed.targetId).toBe('helper');
      expect(parsed.entryCount).toBe(1);

      const filePath = userInsightFilePath('persona', 'helper');
      const raw = await readFile(filePath, 'utf-8');
      const entries = JSON.parse(raw);
      expect(Array.isArray(entries)).toBe(true);
      expect(entries).toHaveLength(1);
      expect(entries[0].insight).toBe(
        'The helper persona should be more concise.'
      );
      expect(entries[0].timestamp).toBeDefined();
    });
  });

  it('writes an insight for a project-level skill', async () => {
    const skillsCap = {
      getSkills: () => [
        {
          id: 'testing',
          name: 'Testing',
          description: 'Testing skill',
          recall: [],
          modelInvocation: true,
          body: '...',
          source: 'project' as const,
        },
      ],
      getSkill: (id: string) =>
        id === 'testing'
          ? {
              id: 'testing',
              name: 'Testing',
              description: 'Testing skill',
              recall: [],
              modelInvocation: true,
              body: '...',
              source: 'project' as const,
            }
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

  it('writes an insight for a user-level skill', async () => {
    await withTempHome(async () => {
      const skillsCap = {
        getSkills: () => [
          {
            id: 'helper-skill',
            name: 'Helper',
            description: 'A helper skill',
            recall: [],
            modelInvocation: true,
            body: '...',
            source: 'user' as const,
          },
        ],
        getSkill: (id: string) =>
          id === 'helper-skill'
            ? {
                id: 'helper-skill',
                name: 'Helper',
                description: 'A helper skill',
                recall: [],
                modelInvocation: true,
                body: '...',
                source: 'user' as const,
              }
            : undefined,
      };

      const engine = await createEngine({ skillsCapability: skillsCap });

      const result = await engine.executeTool('self-improvement.insight', {
        targetType: 'skill',
        targetId: 'helper-skill',
        insight: 'The helper skill should be more detailed.',
      });

      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.targetType).toBe('skill');
      expect(parsed.targetId).toBe('helper-skill');
      expect(parsed.entryCount).toBe(1);

      const filePath = userInsightFilePath('skill', 'helper-skill');
      const raw = await readFile(filePath, 'utf-8');
      const entries = JSON.parse(raw);
      expect(Array.isArray(entries)).toBe(true);
      expect(entries).toHaveLength(1);
      expect(entries[0].insight).toBe(
        'The helper skill should be more detailed.'
      );
      expect(entries[0].timestamp).toBeDefined();
    });
  });

  it('appends to an existing insights file', async () => {
    const personaCap = {
      getPersonas: () => [
        {
          id: 'reviewer',
          name: 'Reviewer',
          description: 'A review persona',
          scope: 'project' as const,
        },
      ],
      getActivePersona: () => null,
      selectPersona: () => {},
      onPersonaChange: () => {},
      reloadPersonas: async () => {},
    };

    const engine = await createEngine({ personaCapability: personaCap });

    await engine.executeTool('self-improvement.insight', {
      targetType: 'persona',
      targetId: 'reviewer',
      insight: 'First insight.',
    });

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
      expect(entries[0].insight).toBe(
        'The plugin architecture should use dependency injection.'
      );
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

  describe('insight-targets prompt fragment', () => {
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
      const fragment = fragments.find(f =>
        f.includes('Current active persona')
      );
      expect(fragment).toBeDefined();
      expect(fragment).toContain('code');
      expect(fragment).toContain('self-improvement.insight');
      expect(fragment).toContain('persona.list');
      expect(fragment).toContain('skills.list');
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
      const fragment = fragments.find(f => f.includes('persona.list'));
      expect(fragment).toBeDefined();
      expect(fragment).not.toContain('Current active persona');
      expect(fragment).toContain('persona.list');
      expect(fragment).toContain('skills.list');
    });

    it('renders the discovery hint when neither persona nor skills plugins are loaded', async () => {
      const engine = await createEngine();
      const fragments = await engine.renderPromptFragments();
      const fragment = fragments.find(f => f.includes('persona.list'));
      expect(fragment).toBeDefined();
      expect(fragment).toContain('persona.list');
      expect(fragment).toContain('skills.list');
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

  describe('tool registration', () => {
    it('registers all new tools', async () => {
      const engine = await createEngine();
      const toolNames = engine.listTools().map(t => t.name);

      expect(toolNames).toContain('self-improvement.insights-list');
      expect(toolNames).toContain('self-improvement.insights-recall');
      expect(toolNames).toContain('self-improvement.principles-store');
      expect(toolNames).toContain('self-improvement.principles-list');
      expect(toolNames).toContain('self-improvement.principles-recall');
      expect(toolNames).toContain('self-improvement.principles-delete');
    });
  });

  describe('self-improvement.insights-list', () => {
    it('returns empty list when no insights exist', async () => {
      const engine = await createEngine();
      const result = await engine.executeTool(
        'self-improvement.insights-list',
        {}
      );
      const parsed = JSON.parse(result);
      expect(parsed.insights).toEqual([]);
    });

    it('lists project insights', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.insight', {
        targetType: 'project',
        targetId: 'architecture',
        insight: 'Architecture insight.',
      });

      const result = await engine.executeTool(
        'self-improvement.insights-list',
        {}
      );
      const parsed = JSON.parse(result);
      expect(parsed.insights).toHaveLength(1);
      expect(parsed.insights[0].targetType).toBe('project');
      expect(parsed.insights[0].targetId).toBe('architecture');
      expect(parsed.insights[0].entryCount).toBe(1);
      expect(parsed.insights[0].lastTimestamp).toBeDefined();
    });

    it('lists skill insights', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.insight', {
        targetType: 'skill',
        targetId: 'my-skill',
        insight: 'Skill insight.',
      });

      const result = await engine.executeTool(
        'self-improvement.insights-list',
        {}
      );
      const parsed = JSON.parse(result);
      expect(parsed.insights).toHaveLength(1);
      expect(parsed.insights[0].targetType).toBe('skill');
      expect(parsed.insights[0].targetId).toBe('my-skill');
    });

    it('lists persona insights', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.insight', {
        targetType: 'persona',
        targetId: 'my-persona',
        insight: 'Persona insight.',
      });

      const result = await engine.executeTool(
        'self-improvement.insights-list',
        {}
      );
      const parsed = JSON.parse(result);
      expect(parsed.insights).toHaveLength(1);
      expect(parsed.insights[0].targetType).toBe('persona');
      expect(parsed.insights[0].targetId).toBe('my-persona');
    });

    it('filters by targetType', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.insight', {
        targetType: 'project',
        targetId: 'arch',
        insight: 'Arch insight.',
      });
      await engine.executeTool('self-improvement.insight', {
        targetType: 'skill',
        targetId: 'test',
        insight: 'Test insight.',
      });

      const result = await engine.executeTool(
        'self-improvement.insights-list',
        {
          targetType: 'project',
        }
      );
      const parsed = JSON.parse(result);
      expect(parsed.insights).toHaveLength(1);
      expect(parsed.insights[0].targetType).toBe('project');
      expect(parsed.insights[0].targetId).toBe('arch');
    });
  });

  describe('self-improvement.insights-recall', () => {
    it('returns insights for a valid target', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.insight', {
        targetType: 'project',
        targetId: 'testing',
        insight: 'Test insight one.',
      });
      await engine.executeTool('self-improvement.insight', {
        targetType: 'project',
        targetId: 'testing',
        insight: 'Test insight two.',
      });

      const result = await engine.executeTool(
        'self-improvement.insights-recall',
        {
          targetType: 'project',
          targetId: 'testing',
        }
      );
      const parsed = JSON.parse(result);
      expect(parsed.targetType).toBe('project');
      expect(parsed.targetId).toBe('testing');
      expect(parsed.entries).toHaveLength(2);
      expect(parsed.entries[0].insight).toBe('Test insight one.');
      expect(parsed.entries[1].insight).toBe('Test insight two.');
    });

    it('returns empty array when no insights exist', async () => {
      const engine = await createEngine();

      const result = await engine.executeTool(
        'self-improvement.insights-recall',
        {
          targetType: 'project',
          targetId: 'nonexistent',
        }
      );
      const parsed = JSON.parse(result);
      expect(parsed.entries).toEqual([]);
    });

    it('rejects invalid targetType', async () => {
      const engine = await createEngine();

      await expect(
        engine.executeTool('self-improvement.insights-recall', {
          targetType: 'invalid',
          targetId: 'foo',
        })
      ).rejects.toThrow(/Invalid targetType/);
    });

    it('rejects empty targetId', async () => {
      const engine = await createEngine();

      await expect(
        engine.executeTool('self-improvement.insights-recall', {
          targetType: 'project',
          targetId: '',
        })
      ).rejects.toThrow(/targetId must be a non-empty string/);
    });
  });

  describe('self-improvement.principles-store', () => {
    it('stores a principle for a project', async () => {
      const engine = await createEngine();

      const result = await engine.executeTool(
        'self-improvement.principles-store',
        {
          targetType: 'project',
          targetId: 'architecture',
          principle: 'Always use dependency injection.',
          source: 'Derived from insights',
        }
      );

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

      const result = await engine.executeTool(
        'self-improvement.principles-store',
        {
          targetType: 'persona',
          targetId: 'coder',
          principle: 'Be concise in responses.',
        }
      );

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

      const result = await engine.executeTool(
        'self-improvement.principles-store',
        {
          targetType: 'skill',
          targetId: 'testing',
          principle: 'Always include edge cases.',
        }
      );

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

      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'project',
        targetId: 'workflow',
        principle: 'First principle.',
      });

      const result = await engine.executeTool(
        'self-improvement.principles-store',
        {
          targetType: 'project',
          targetId: 'workflow',
          principle: 'Second principle.',
        }
      );

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
        engine.executeTool('self-improvement.principles-store', {
          targetType: 'project',
          targetId: 'test',
          principle: '',
        })
      ).rejects.toThrow(/principle must be a non-empty string/);
    });

    it('rejects invalid targetType', async () => {
      const engine = await createEngine();

      await expect(
        engine.executeTool('self-improvement.principles-store', {
          targetType: 'invalid',
          targetId: 'test',
          principle: 'A principle.',
        })
      ).rejects.toThrow(/Invalid targetType/);
    });

    it('stores a principle without source', async () => {
      const engine = await createEngine();

      const result = await engine.executeTool(
        'self-improvement.principles-store',
        {
          targetType: 'project',
          targetId: 'test',
          principle: 'No source principle.',
        }
      );

      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);

      const filePath = principleFilePath(tmpDir, 'project', 'test');
      const raw = await readFile(filePath, 'utf-8');
      const entries = JSON.parse(raw);
      expect(entries[0].source).toBeUndefined();
    });
  });

  describe('self-improvement.principles-list', () => {
    it('returns empty list when no principles exist', async () => {
      const engine = await createEngine();
      const result = await engine.executeTool(
        'self-improvement.principles-list',
        {}
      );
      const parsed = JSON.parse(result);
      expect(parsed.principles).toEqual([]);
    });

    it('lists all principle files', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'project',
        targetId: 'arch',
        principle: 'Principle one.',
      });
      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'skill',
        targetId: 'test',
        principle: 'Principle two.',
      });

      const result = await engine.executeTool(
        'self-improvement.principles-list',
        {}
      );
      const parsed = JSON.parse(result);
      expect(parsed.principles).toHaveLength(2);
    });

    it('filters by targetType', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'project',
        targetId: 'arch',
        principle: 'Project principle.',
      });
      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'skill',
        targetId: 'test',
        principle: 'Skill principle.',
      });

      const result = await engine.executeTool(
        'self-improvement.principles-list',
        {
          targetType: 'project',
        }
      );
      const parsed = JSON.parse(result);
      expect(parsed.principles).toHaveLength(1);
      expect(parsed.principles[0].targetType).toBe('project');
    });
  });

  describe('self-improvement.principles-recall', () => {
    it('returns principles for a valid target', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'project',
        targetId: 'testing',
        principle: 'Principle one.',
      });
      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'project',
        targetId: 'testing',
        principle: 'Principle two.',
      });

      const result = await engine.executeTool(
        'self-improvement.principles-recall',
        {
          targetType: 'project',
          targetId: 'testing',
        }
      );
      const parsed = JSON.parse(result);
      expect(parsed.targetType).toBe('project');
      expect(parsed.targetId).toBe('testing');
      expect(parsed.principles).toHaveLength(2);
      expect(parsed.principles[0].principle).toBe('Principle one.');
      expect(parsed.principles[1].principle).toBe('Principle two.');
    });

    it('returns empty array when no principles exist', async () => {
      const engine = await createEngine();

      const result = await engine.executeTool(
        'self-improvement.principles-recall',
        {
          targetType: 'project',
          targetId: 'nonexistent',
        }
      );
      const parsed = JSON.parse(result);
      expect(parsed.principles).toEqual([]);
    });

    it('rejects invalid targetType', async () => {
      const engine = await createEngine();

      await expect(
        engine.executeTool('self-improvement.principles-recall', {
          targetType: 'invalid',
          targetId: 'foo',
        })
      ).rejects.toThrow(/Invalid targetType/);
    });
  });

  describe('self-improvement.principles-delete', () => {
    it('deletes a principle by index', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'project',
        targetId: 'test',
        principle: 'Keep me.',
      });
      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'project',
        targetId: 'test',
        principle: 'Delete me.',
      });

      const result = await engine.executeTool(
        'self-improvement.principles-delete',
        {
          targetType: 'project',
          targetId: 'test',
          index: 1,
        }
      );

      const parsed = JSON.parse(result);
      expect(parsed.ok).toBe(true);
      expect(parsed.remainingCount).toBe(1);

      const recallResult = await engine.executeTool(
        'self-improvement.principles-recall',
        {
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

      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'project',
        targetId: 'test',
        principle: 'Only one.',
      });

      await expect(
        engine.executeTool('self-improvement.principles-delete', {
          targetType: 'project',
          targetId: 'test',
          index: 5,
        })
      ).rejects.toThrow(/out of bounds/);
    });

    it('rejects negative index', async () => {
      const engine = await createEngine();

      await expect(
        engine.executeTool('self-improvement.principles-delete', {
          targetType: 'project',
          targetId: 'test',
          index: -1,
        })
      ).rejects.toThrow(/index must be a non-negative integer/);
    });

    it('removes the file when last principle is deleted', async () => {
      const engine = await createEngine();

      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'project',
        targetId: 'test',
        principle: 'Only one.',
      });

      await engine.executeTool('self-improvement.principles-delete', {
        targetType: 'project',
        targetId: 'test',
        index: 0,
      });

      const filePath = principleFilePath(tmpDir, 'project', 'test');
      await expect(readFile(filePath, 'utf-8')).rejects.toThrow();
    });
  });

  describe('combined principles prompt fragment', () => {
    it('renders project principles when they exist', async () => {
      const engine = await createEngine();

      // Store a project principle
      await engine.executeTool('self-improvement.principles-store', {
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

      await engine.executeTool('self-improvement.principles-store', {
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
      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'project',
        targetId: 'workflow',
        principle: 'Confirm destructive operations.',
      });

      // Store persona principle
      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'persona',
        targetId: 'coder',
        principle: 'Be concise.',
      });

      const fragments = await engine.renderPromptFragments();
      const fragment = fragments.find(
        f =>
          f.includes('## Current Project') && f.includes('## Current Persona')
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
        f =>
          f.includes('## Current Project') || f.includes('## Current Persona')
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
      await engine.executeTool('self-improvement.principles-store', {
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
                typeof input.id === 'string'
                  ? input.id.trim().toLowerCase()
                  : '';
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

      await engine.executeTool('self-improvement.principles-store', {
        targetType: 'skill',
        targetId: 'test-skill',
        principle: 'Always test edge cases.',
      });

      const result = await engine.executeTool('skills.recall', {
        id: 'test-skill',
      });
      const parsed = JSON.parse(result);
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
                typeof input.id === 'string'
                  ? input.id.trim().toLowerCase()
                  : '';
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

      const result = await engine.executeTool('skills.recall', {
        id: 'test-skill',
      });
      const parsed = JSON.parse(result);
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
                typeof input.id === 'string'
                  ? input.id.trim().toLowerCase()
                  : '';
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

      const result = await engine.executeTool('skills.recall', {
        id: 'test-skill',
      });
      const parsed = JSON.parse(result);
      expect(parsed.body).toBe('Original body.');
      expect(parsed.body).not.toContain('## Principles');
    });
  });
});
