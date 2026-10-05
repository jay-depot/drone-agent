/**
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDefaultAgentConfig,
  type DroneElicitation,
  type DroneElicitationAnswers,
  type DroneElicitationQuestion,
  type DroneOwnedSkillWriter,
  type DronePersonaCapability,
  type DronePersonaDefinition,
  type DroneSkillDefinition,
  type DroneSkillWriter,
  type DroneWorkflowResult,
} from 'drone-core';
import {
  skillsCreateWorkflow,
  slugifySkillId,
} from '../src/plugins/skills/wizard.js';
import { loadSkills } from '../src/plugins/skills/loader.js';
import type { DroneWorkflowContext } from 'drone-core';

function scriptedElicit(
  answers: Array<Record<string, string>>
): DroneElicitation {
  const queue = [...answers];
  return {
    ask: async (questions: DroneElicitationQuestion[]) => {
      const next = queue.shift();
      if (!next) {
        throw new Error(
          `elicitation ran out of scripted answers (asked: ${questions.map(q => q.id).join(', ')})`
        );
      }
      const out: DroneElicitationAnswers = {};
      for (const q of questions) {
        if (!(q.id in next)) {
          throw new Error(
            `scripted elicit missing answer for "${q.id}" (asked: ${questions.map(q2 => q2.id).join(', ')})`
          );
        }
        out[q.id] = next[q.id] as string;
      }
      return out;
    },
  };
}

/**
 * Build an elicitation that answers each asked question from a by-id map,
 * recording the question ids it was asked. Throws when an id has no answer.
 */
function dispatchElicit(
  byId: Record<string, string>,
  asked?: string[][]
): DroneElicitation {
  return {
    ask: async (questions: DroneElicitationQuestion[]) => {
      asked?.push(questions.map(q => q.id));
      const out: DroneElicitationAnswers = {};
      for (const q of questions) {
        if (!(q.id in byId)) {
          throw new Error(`dispatchElicit: no answer for "${q.id}"`);
        }
        out[q.id] = byId[q.id];
      }
      return out;
    },
  };
}

async function withProjectDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-skills-wizard-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeWriters(projectDir: string): {
  project: DroneSkillWriter;
  user: DroneSkillWriter;
} {
  const projectWriter: DroneSkillWriter = {
    id: 'skill-provider-project',
    scope: 'project',
    label: 'Project (./.drone-agent/skills/)',
    exists: async (id: string) => {
      const filePath = path.join(
        projectDir,
        '.drone-agent',
        'skills',
        `${id}.md`
      );
      try {
        await readFile(filePath, 'utf-8');
        return true;
      } catch {
        return false;
      }
    },
    writeSkill: async (id: string, content: string) => {
      const skillsDir = path.join(projectDir, '.drone-agent', 'skills');
      const filePath = path.join(skillsDir, `${id}.md`);
      await mkdir(skillsDir, { recursive: true });
      await writeFile(filePath, content, 'utf-8');
      return { filePath };
    },
  };

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const userWriter: DroneSkillWriter = {
    id: 'skill-provider-user',
    scope: 'user',
    label: 'User (~/.drone-agent/skills/)',
    exists: async (id: string) => {
      const filePath = path.join(homeDir, '.drone-agent', 'skills', `${id}.md`);
      try {
        await readFile(filePath, 'utf-8');
        return true;
      } catch {
        return false;
      }
    },
    writeSkill: async (id: string, content: string) => {
      const skillsDir = path.join(homeDir, '.drone-agent', 'skills');
      const filePath = path.join(skillsDir, `${id}.md`);
      await mkdir(skillsDir, { recursive: true });
      await writeFile(filePath, content, 'utf-8');
      return { filePath };
    },
  };

  return { project: projectWriter, user: userWriter };
}

function makeContext(input: {
  projectDir: string;
  elicit: DroneElicitation;
  capabilities?: Map<string, unknown>;
  ownedWriters?: DroneOwnedSkillWriter[];
  personas?: DronePersonaDefinition[];
  activePersonaId?: string;
}): DroneWorkflowContext {
  const config = createDefaultAgentConfig();
  const caps = input.capabilities ?? new Map<string, unknown>();
  // Add skills capability with writers if not already set
  if (!caps.has('skills')) {
    const writers = makeWriters(input.projectDir);
    caps.set('skills', {
      getWriters: () => [writers.project, writers.user],
      getOwnedWriters: () => input.ownedWriters ?? [],
      reloadSkills: async () => {},
    });
  }
  if (!caps.has('persona')) {
    caps.set(
      'persona',
      makePersonaCap(input.personas ?? [], input.activePersonaId)
    );
  }
  return {
    elicit: input.elicit,
    projectDir: input.projectDir,
    config,
    requestCapability: <T>(id: string): T | undefined =>
      caps.get(id) as T | undefined,
    enablePlugin: async (_pluginId: string) => false,
    agent: async () => {
      throw new Error('ctx.agent not expected in this test');
    },
  };
}

function makePersonaCap(
  personas: DronePersonaDefinition[],
  activePersonaId?: string
): DronePersonaCapability {
  const active = personas.find(p => p.id === activePersonaId) ?? null;
  return {
    getActivePersona: () => active,
    getPersonas: () => personas,
    selectPersona: () => {},
    onPersonaChange: () => {},
    reloadPersonas: async () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    registerWriter: () => {},
    unregisterWriter: () => {},
    getWriters: () => [],
    getFilteredTools: tools => tools,
    getFilteredSkills: (skills: DroneSkillDefinition[]) => skills,
    isSkillVisible: () => true,
  };
}

/**
 * Build an owned-skill writer for a scope with a recorded write-call log and
 * a controllable existence set (composite `<personaId>/<skillId>` keys).
 */
function makeOwnedWriter(
  scope: DroneOwnedSkillWriter['scope'],
  options: { existing?: string[] } = {}
): {
  writer: DroneOwnedSkillWriter;
  calls: Array<{ personaId: string; id: string; content: string }>;
} {
  const existing = new Set(options.existing ?? []);
  const calls: Array<{ personaId: string; id: string; content: string }> = [];
  const writer: DroneOwnedSkillWriter = {
    id: `persona-owned-skills-${scope}`,
    scope,
    labelFor: personaId => `Owned by persona "${personaId}" (${scope})`,
    exists: async (personaId, id) => existing.has(`${personaId}/${id}`),
    writeSkill: async (personaId, id, content) => {
      calls.push({ personaId, id, content });
      return { filePath: `/mem/personas/${personaId}/skills/${id}.md` };
    },
  };
  return { writer, calls };
}

function persona(id: string, scope: DronePersonaDefinition['scope']) {
  return { id, name: id, description: `Persona ${id}`, scope };
}

/**
 * Run the wizard and assert the return value is a DroneWorkflowResult.
 */
async function runWizard(
  args: Record<string, unknown>,
  ctx: DroneWorkflowContext
): Promise<DroneWorkflowResult> {
  const raw = await skillsCreateWorkflow.run(args, ctx);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`wizard returned non-object: ${String(raw)}`);
  }
  return raw as DroneWorkflowResult;
}

describe('slugifySkillId', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifySkillId('Hello World! 2')).toBe('hello-world-2');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugifySkillId('!!foo!!')).toBe('foo');
  });

  it('returns empty for all-symbol input', () => {
    expect(slugifySkillId('!!!')).toBe('');
  });

  it('caps length at 64 chars', () => {
    const long = 'a'.repeat(80);
    expect(slugifySkillId(long).length).toBe(64);
  });
});

describe('skillsCreateWorkflow — happy path', () => {
  it('writes a skeleton skill file with all four prompts', async () => {
    await withProjectDir(async projectDir => {
      const result = await runWizard(
        {},
        makeContext({
          projectDir,
          elicit: scriptedElicit([
            { scope: 'project' },
            { id: 'webapp-testing' },
            { description: 'Test web applications using Playwright.' },
            {
              recall:
                'The user mentions testing a web app\n- The project has Playwright config',
            },
          ]),
        })
      );
      const filePath = path.join(
        projectDir,
        '.drone-agent',
        'skills',
        'webapp-testing.md'
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('name: webapp-testing');
      expect(written).toContain(
        "description: 'Test web applications using Playwright.'"
      );
      expect(written).toContain('The user mentions testing a web app');
      expect(written).toContain('The project has Playwright config');
      expect(written).toContain('model-invocation: true');
      expect(written).toContain(
        '<!-- TODO: The coding agent should fill in this body'
      );
      expect(result.toolResult).toBeDefined();
      expect(result.kickMessage).toMatch(/webapp-testing/);
      expect(result.kickMessage).toMatch(/explore the codebase/);
      const parsed = JSON.parse(result.toolResult ?? '{}');
      expect(parsed.id).toBe('webapp-testing');
      expect(parsed.scope).toBe('project');
      expect(parsed.filePath).toBe(filePath);
      expect(parsed.isSkeleton).toBe(true);
    });
  });

  it('uses input overrides to skip prompts', async () => {
    await withProjectDir(async projectDir => {
      const result = await runWizard(
        {
          scope: 'project',
          id: 'webapp-testing',
          description: 'Test web applications using Playwright.',
          recall: 'The user mentions testing a web app',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([]),
        })
      );
      const filePath = path.join(
        projectDir,
        '.drone-agent',
        'skills',
        'webapp-testing.md'
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('name: webapp-testing');
      const parsed = JSON.parse(result.toolResult ?? '{}');
      expect(parsed.id).toBe('webapp-testing');
      expect(parsed.scope).toBe('project');
    });
  });

  it('writes to user scope when selected', async () => {
    await withProjectDir(async projectDir => {
      const result = await runWizard(
        {
          id: 'my-skill',
          description: 'A user-level skill.',
          recall: 'Some condition',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([{ scope: 'user' }]),
        })
      );
      // User scope writes to homedir, not projectDir
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const filePath = path.join(
        homeDir,
        '.drone-agent',
        'skills',
        'my-skill.md'
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('name: my-skill');
      const parsed = JSON.parse(result.toolResult ?? '{}');
      expect(parsed.id).toBe('my-skill');
      expect(parsed.scope).toBe('user');
      // Clean up
      await rm(filePath, { force: true });
    });
  });

  it('allows empty recall conditions', async () => {
    await withProjectDir(async projectDir => {
      const result = await runWizard(
        {
          scope: 'project',
          id: 'no-recall',
          description: 'A skill with no recall conditions.',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([{ recall: '' }]),
        })
      );
      const filePath = path.join(
        projectDir,
        '.drone-agent',
        'skills',
        'no-recall.md'
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('<TODO: add recall conditions>');
      expect(result.toolResult).toBeDefined();
      const parsed = JSON.parse(result.toolResult ?? '{}');
      expect(parsed.recallCount).toBe(0);
    });
  });
});

describe('skillsCreateWorkflow — overwrite prompts', () => {
  it('asks overwriteAtName when the file already exists, accepts "yes", rewrites', async () => {
    await withProjectDir(async projectDir => {
      const skillsDir = path.join(projectDir, '.drone-agent', 'skills');
      await mkdir(skillsDir, { recursive: true });
      const filePath = path.join(skillsDir, 'webapp-testing.md');
      await writeFile(
        filePath,
        '---\nname: webapp-testing\ndescription: OLD\n---\n# OLD body\n',
        'utf-8'
      );
      const result = await runWizard(
        {
          scope: 'project',
          id: 'webapp-testing',
          description: 'Test web applications using Playwright.',
          recall: 'The user mentions testing',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([{ overwrite: 'yes' }]),
        })
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain(
        "description: 'Test web applications using Playwright.'"
      );
      expect(written).not.toContain('OLD');
      expect(result.toolResult).toBeDefined();
    });
  });

  it('aborts when overwriteAtName is "no"', async () => {
    await withProjectDir(async projectDir => {
      const skillsDir = path.join(projectDir, '.drone-agent', 'skills');
      await mkdir(skillsDir, { recursive: true });
      const filePath = path.join(skillsDir, 'webapp-testing.md');
      await writeFile(
        filePath,
        '---\nname: webapp-testing\ndescription: OLD\n---\n# OLD body\n',
        'utf-8'
      );
      await expect(
        runWizard(
          {
            scope: 'project',
            id: 'webapp-testing',
            description: 'Test web applications using Playwright.',
            recall: 'The user mentions testing',
          },
          makeContext({
            projectDir,
            elicit: scriptedElicit([{ overwrite: 'no' }]),
          })
        )
      ).rejects.toThrow(/Refusing to overwrite/);
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('OLD body');
    });
  });

  it('overwriteFinal aborts when no prior approval', async () => {
    await withProjectDir(async projectDir => {
      const skillsDir = path.join(projectDir, '.drone-agent', 'skills');
      await mkdir(skillsDir, { recursive: true });
      const filePath = path.join(skillsDir, 'webapp-testing.md');
      const elicit: DroneElicitation = {
        ask: async (questions: DroneElicitationQuestion[]) => {
          for (const q of questions) {
            if (q.id === 'id') {
              const out: DroneElicitationAnswers = { id: 'webapp-testing' };
              return out;
            }
            if (q.id === 'description') {
              // Race: file appears mid-wizard.
              await writeFile(
                filePath,
                '---\nname: webapp-testing\ndescription: SURPRISE\n---\n# surprise\n',
                'utf-8'
              );
              return { description: 'Test web applications.' };
            }
            if (q.id === 'recall') {
              return { recall: 'The user mentions testing' };
            }
            if (q.id === 'overwrite') {
              const out: DroneElicitationAnswers = { overwrite: 'no' };
              return out;
            }
          }
          throw new Error('unexpected question: ' + questions.map(q => q.id));
        },
      };
      await expect(
        runWizard(
          { scope: 'project' },
          makeContext({
            projectDir,
            elicit,
          })
        )
      ).rejects.toThrow(/Refusing to overwrite/);
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('SURPRISE');
    });
  });
});

describe('skillsCreateWorkflow — reload capability', () => {
  it('calls reloadSkills when the skills capability is offered', async () => {
    await withProjectDir(async projectDir => {
      let reloaded = 0;
      const writers = makeWriters(projectDir);
      const capabilities = new Map<string, unknown>([
        [
          'skills',
          {
            getWriters: () => [writers.project, writers.user],
            getOwnedWriters: () => [],
            reloadSkills: async () => {
              reloaded += 1;
            },
          },
        ],
      ]);
      const result = await runWizard(
        {
          scope: 'project',
          id: 'webapp-testing',
          description: 'Test web applications using Playwright.',
          recall: 'The user mentions testing',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([]),
          capabilities,
        })
      );
      expect(reloaded).toBe(1);
      const loaded = await loadSkills(projectDir);
      expect(loaded.has('webapp-testing')).toBe(true);
      expect(result.toolResult).toBeDefined();
    });
  });

  it('does not throw when the skills capability is missing', async () => {
    await withProjectDir(async projectDir => {
      const config = createDefaultAgentConfig();
      const caps = new Map<string, unknown>();
      // No 'skills' key
      await expect(
        runWizard(
          {
            scope: 'project',
            id: 'webapp-testing',
            description: 'Test web applications using Playwright.',
            recall: 'The user mentions testing',
          },
          {
            elicit: scriptedElicit([]),
            projectDir,
            config,
            requestCapability: <T>(id: string): T | undefined =>
              caps.get(id) as T | undefined,
            enablePlugin: async (_pluginId: string) => false,
            agent: async () => {
              throw new Error('ctx.agent not expected in this test');
            },
          }
        )
      ).rejects.toThrow(/requires the skills broker plugin/);
    });
  });
});

describe('skillsCreateWorkflow — skeleton content', () => {
  it('includes all expected sections in the skeleton', async () => {
    await withProjectDir(async projectDir => {
      await runWizard(
        {
          scope: 'project',
          id: 'my-skill',
          description: 'A test skill.',
          recall: 'Condition one\nCondition two',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([]),
        })
      );
      const filePath = path.join(
        projectDir,
        '.drone-agent',
        'skills',
        'my-skill.md'
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('name: my-skill');
      expect(written).toContain("description: 'A test skill.'");
      expect(written).toContain('  - Condition one');
      expect(written).toContain('  - Condition two');
      expect(written).toContain('model-invocation: true');
      expect(written).toContain('## Overview');
      expect(written).toContain('## Instructions');
      expect(written).toContain('## Examples');
      expect(written).toContain(
        '<!-- TODO: The coding agent should fill in this body'
      );
    });
  });
});

describe('skillsCreateWorkflow — owner-first target selection', () => {
  it('offers the owner picker with a global default when owned writers exist', async () => {
    await withProjectDir(async projectDir => {
      const { writer } = makeOwnedWriter('project');
      const asked: string[][] = [];
      const elicit = dispatchElicit(
        {
          owner: '',
          scope: 'project',
          id: 'owned-test',
          description: 'Owned.',
          recall: '',
        },
        asked
      );
      const result = await runWizard(
        {},
        makeContext({
          projectDir,
          elicit,
          ownedWriters: [writer],
          personas: [persona('alice', 'project')],
        })
      );
      expect(asked[0]).toEqual(['owner']);
      const filePath = path.join(
        projectDir,
        '.drone-agent',
        'skills',
        'owned-test.md'
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('name: owned-test');
      const parsed = JSON.parse(result.toolResult ?? '{}');
      expect(parsed.personaId).toBeNull();
    });
  });

  it('derives the scope from the selected owner and never asks for one', async () => {
    await withProjectDir(async projectDir => {
      const { writer, calls } = makeOwnedWriter('project');
      const asked: string[][] = [];
      const elicit = dispatchElicit(
        {
          owner: 'alice',
          id: 'owned-test',
          description: 'Owned.',
          recall: '',
        },
        asked
      );
      const result = await runWizard(
        {},
        makeContext({
          projectDir,
          elicit,
          ownedWriters: [writer],
          personas: [persona('alice', 'project')],
        })
      );
      expect(asked.some(ids => ids.includes('scope'))).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0].personaId).toBe('alice');
      expect(calls[0].id).toBe('owned-test');
      const parsed = JSON.parse(result.toolResult ?? '{}');
      expect(parsed.personaId).toBe('alice');
      expect(parsed.scope).toBe('project');
    });
  });

  it("asks exactly today's single scope question when no owned writers exist", async () => {
    await withProjectDir(async projectDir => {
      const asked: string[][] = [];
      const elicit = dispatchElicit(
        {
          scope: 'project',
          id: 'plain',
          description: 'Plain.',
          recall: '',
        },
        asked
      );
      await runWizard(
        {},
        makeContext({
          projectDir,
          elicit,
          ownedWriters: [],
          personas: [persona('alice', 'project')],
        })
      );
      expect(asked[0]).toEqual(['scope']);
      expect(asked.some(ids => ids.includes('owner'))).toBe(false);
    });
  });

  it('fast-paths a supplied personaId, skipping the owner question', async () => {
    await withProjectDir(async projectDir => {
      const { writer, calls } = makeOwnedWriter('project');
      const asked: string[][] = [];
      const elicit = dispatchElicit(
        {
          id: 'owned-fast',
          description: 'Fast.',
          recall: '',
        },
        asked
      );
      const result = await runWizard(
        { personaId: 'alice' },
        makeContext({
          projectDir,
          elicit,
          ownedWriters: [writer],
          personas: [persona('alice', 'project')],
        })
      );
      expect(asked.some(ids => ids.includes('owner'))).toBe(false);
      expect(calls[0].personaId).toBe('alice');
      const parsed = JSON.parse(result.toolResult ?? '{}');
      expect(parsed.personaId).toBe('alice');
    });
  });

  it('throws when personaId does not resolve to a loadable owner', async () => {
    await withProjectDir(async projectDir => {
      const { writer } = makeOwnedWriter('project');
      await expect(
        runWizard(
          { personaId: 'ghost' },
          makeContext({
            projectDir,
            elicit: scriptedElicit([]),
            ownedWriters: [writer],
            personas: [persona('alice', 'project')],
          })
        )
      ).rejects.toThrow(/Cannot author a skill owned by persona "ghost"/);
    });
  });

  it("throws when the owner's scope has no owned writer", async () => {
    await withProjectDir(async projectDir => {
      await expect(
        runWizard(
          { personaId: 'bob' },
          makeContext({
            projectDir,
            elicit: scriptedElicit([]),
            ownedWriters: [makeOwnedWriter('project').writer],
            personas: [persona('bob', 'coordinator')],
          })
        )
      ).rejects.toThrow(/Cannot author a skill owned by persona "bob"/);
    });
  });

  it('overwrite on the owned writer keys on the composite identity', async () => {
    await withProjectDir(async projectDir => {
      const { writer } = makeOwnedWriter('project', {
        existing: ['alice/existing-skill'],
      });
      await expect(
        runWizard(
          { personaId: 'alice' },
          makeContext({
            projectDir,
            elicit: scriptedElicit([
              { id: 'existing-skill' },
              { overwrite: 'no' },
            ]),
            ownedWriters: [writer],
            personas: [persona('alice', 'project')],
          })
        )
      ).rejects.toThrow(/Refusing to overwrite/);
    });
  });
});

describe('skillsCreateWorkflow — kickMessage and reload wiring', () => {
  it('names the persona select command when the owner is not active', async () => {
    await withProjectDir(async projectDir => {
      const { writer } = makeOwnedWriter('project');
      const result = await runWizard(
        { personaId: 'alice' },
        makeContext({
          projectDir,
          elicit: scriptedElicit([
            { id: 'owned-kick' },
            { description: 'Kick.' },
            { recall: '' },
          ]),
          ownedWriters: [writer],
          personas: [persona('alice', 'project')],
        })
      );
      expect(result.kickMessage).toMatch(/\/persona select alice/);
    });
  });

  it('does not name the persona select command when the owner is active', async () => {
    await withProjectDir(async projectDir => {
      const { writer } = makeOwnedWriter('project');
      const result = await runWizard(
        { personaId: 'alice' },
        makeContext({
          projectDir,
          elicit: scriptedElicit([
            { id: 'owned-kick-two' },
            { description: 'Kick.' },
            { recall: '' },
          ]),
          ownedWriters: [writer],
          personas: [persona('alice', 'project')],
          activePersonaId: 'alice',
        })
      );
      expect(result.kickMessage).not.toMatch(/\/persona select/);
      expect(result.kickMessage).toMatch(/active persona "alice"/);
    });
  });

  it('reloads personas before skills after an owned write', async () => {
    await withProjectDir(async projectDir => {
      const { writer } = makeOwnedWriter('project');
      const order: string[] = [];
      const writers = makeWriters(projectDir);
      const caps = new Map<string, unknown>([
        [
          'skills',
          {
            getWriters: () => [writers.project, writers.user],
            getOwnedWriters: () => [writer],
            reloadSkills: async () => {
              order.push('skills');
            },
          },
        ],
      ]);
      const personaCap = makePersonaCap([persona('alice', 'project')]);
      personaCap.reloadPersonas = async () => {
        order.push('persona');
      };
      caps.set('persona', personaCap);
      await runWizard(
        { personaId: 'alice' },
        makeContext({
          projectDir,
          elicit: scriptedElicit([
            { id: 'owned-reload' },
            { description: 'Reload.' },
            { recall: '' },
          ]),
          capabilities: caps,
        })
      );
      expect(order).toEqual(['persona', 'skills']);
    });
  });
});
