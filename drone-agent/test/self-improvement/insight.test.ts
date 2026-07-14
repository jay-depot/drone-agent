import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  insightFilePath,
  userInsightFilePath,
  withTempHome,
  createEngine,
} from './setup.js';

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

  it('registers the self-improvement.insight tool', async () => {
    const engine = await createEngine();
    const tools = engine.listTools();
    const insightTool = tools.find(t => t.name === 'self-improvement__insight');
    expect(insightTool).toBeDefined();
    expect(insightTool!.description).toContain('insight');
    expect(insightTool!.inputSchema).toBeDefined();
    expect(insightTool!.inputSchema!.required).toContain('action');
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

    const result = await engine.executeTool('self-improvement__insight', {
      action: 'record',
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

      const result = await engine.executeTool('self-improvement__insight', {
        action: 'record',
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

    const result = await engine.executeTool('self-improvement__insight', {
      action: 'record',
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

      const result = await engine.executeTool('self-improvement__insight', {
        action: 'record',
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

    await engine.executeTool('self-improvement__insight', {
      action: 'record',
      targetType: 'persona',
      targetId: 'reviewer',
      insight: 'First insight.',
    });

    const result = await engine.executeTool('self-improvement__insight', {
      action: 'record',
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
      engine.executeTool('self-improvement__insight', {
        action: 'record',
        targetType: 'invalid',
        targetId: 'foo',
        insight: 'Some insight.',
      })
    ).rejects.toThrow(/Invalid targetType/);
  });

  it('rejects empty targetId', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__insight', {
        action: 'record',
        targetType: 'persona',
        targetId: '',
        insight: 'Some insight.',
      })
    ).rejects.toThrow(/targetId must be a non-empty string/);
  });

  it('rejects empty insight', async () => {
    const engine = await createEngine();

    await expect(
      engine.executeTool('self-improvement__insight', {
        action: 'record',
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
      engine.executeTool('self-improvement__insight', {
        action: 'record',
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
      engine.executeTool('self-improvement__insight', {
        action: 'record',
        targetType: 'skill',
        targetId: 'nonexistent',
        insight: 'Some insight.',
      })
    ).rejects.toThrow(/Unknown skill/);
  });

  it('works without persona or skills plugins loaded', async () => {
    const engine = await createEngine();

    const result = await engine.executeTool('self-improvement__insight', {
      action: 'record',
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

    const result = await engine.executeTool('self-improvement__insight', {
      action: 'record',
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
});
