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
  type DroneLlmProvider,
  type DronePersonaWriter,
  type DroneWorkflowResult,
} from 'drone-core';
import {
  personaCreateWorkflow,
  slugifyPersonaId,
} from '../src/plugins/persona/wizard.js';
import { loadPersonas } from '../src/plugins/persona/loader.js';
import type { DroneWorkflowContext } from 'drone-core';

const PERSONA_MD = (id: string, name?: string) => {
  const display = name ?? id;
  return `---
name: ${display}
description: A test persona.
color: cyan
---
A test persona body.
`;
};

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

function makeProvider(md: string): {
  provider: DroneLlmProvider;
  callCount: () => number;
} {
  let count = 0;
  const current = md;
  return {
    provider: {
      chat: async () => {
        count += 1;
        return { message: current };
      },
    },
    callCount: () => count,
  };
}

async function withProjectDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'drone-wizard-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeWriters(projectDir: string): {
  project: DronePersonaWriter;
  user: DronePersonaWriter;
} {
  const projectWriter: DronePersonaWriter = {
    id: 'persona-provider-project',
    scope: 'project',
    label: 'Project (./.drone-agent/personas/<name>/persona.md)',
    exists: async (id: string) => {
      const filePath = path.join(
        projectDir,
        '.drone-agent',
        'personas',
        id,
        'persona.md'
      );
      try {
        await readFile(filePath, 'utf-8');
        return true;
      } catch {
        return false;
      }
    },
    writePersona: async (id: string, content: string) => {
      const targetDir = path.join(projectDir, '.drone-agent', 'personas', id);
      const filePath = path.join(targetDir, 'persona.md');
      await mkdir(targetDir, { recursive: true });
      await writeFile(filePath, content, 'utf-8');
      return { filePath };
    },
  };

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const userWriter: DronePersonaWriter = {
    id: 'persona-provider-user',
    scope: 'user',
    label: 'User (~/.drone-agent/personas/<name>/persona.md)',
    exists: async (id: string) => {
      const filePath = path.join(
        homeDir,
        '.drone-agent',
        'personas',
        id,
        'persona.md'
      );
      try {
        await readFile(filePath, 'utf-8');
        return true;
      } catch {
        return false;
      }
    },
    writePersona: async (id: string, content: string) => {
      const targetDir = path.join(homeDir, '.drone-agent', 'personas', id);
      const filePath = path.join(targetDir, 'persona.md');
      await mkdir(targetDir, { recursive: true });
      await writeFile(filePath, content, 'utf-8');
      return { filePath };
    },
  };

  return { project: projectWriter, user: userWriter };
}

function makeContext(input: {
  projectDir: string;
  elicit: DroneElicitation;
  provider: DroneLlmProvider;
  capabilities?: Map<string, unknown>;
}): DroneWorkflowContext {
  const config = createDefaultAgentConfig();
  const caps = input.capabilities ?? new Map<string, unknown>();
  if (!caps.has('llm')) {
    caps.set('llm', {
      resolveModelForRole: () => ({
        provider: input.provider,
        providerId: 'test-provider',
        model: 'test-model',
      }),
    });
  }
  // Add persona capability with writers if not already set
  if (!caps.has('persona')) {
    const writers = makeWriters(input.projectDir);
    caps.set('persona', {
      getWriters: () => [writers.project, writers.user],
      reloadPersonas: async () => {},
    });
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

/**
 * Run the wizard and assert the return value is a DroneWorkflowResult.
 */
async function runWizard(
  args: Record<string, unknown>,
  ctx: DroneWorkflowContext
): Promise<DroneWorkflowResult> {
  const raw = await personaCreateWorkflow.run(args, ctx);
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`wizard returned non-object: ${String(raw)}`);
  }
  return raw as DroneWorkflowResult;
}

/** Helper: create a persona subdirectory with a persona.md file. */
async function writePersona(
  personaDir: string,
  id: string,
  content: string
): Promise<string> {
  const subDir = path.join(personaDir, id);
  await mkdir(subDir, { recursive: true });
  const filePath = path.join(subDir, 'persona.md');
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

describe('slugifyPersonaId', () => {
  it('lowercases and hyphenates', () => {
    expect(slugifyPersonaId('Hello World! 2')).toBe('hello-world-2');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugifyPersonaId('!!foo!!')).toBe('foo');
  });

  it('returns empty for all-symbol input', () => {
    expect(slugifyPersonaId('!!!')).toBe('');
  });

  it('caps length at 64 chars', () => {
    const long = 'a'.repeat(80);
    expect(slugifyPersonaId(long).length).toBe(64);
  });
});

describe('personaCreateWorkflow — happy path', () => {
  it('writes a persona file with all four prompts', async () => {
    await withProjectDir(async projectDir => {
      const provider = makeProvider(PERSONA_MD('reviewer'));
      const result = await runWizard(
        {},
        makeContext({
          projectDir,
          elicit: scriptedElicit([
            { scope: 'project' },
            { id: 'reviewer' },
            { description: 'Reviews code with focus on edge cases.' },
          ]),
          provider: provider.provider,
        })
      );
      const filePath = path.join(
        projectDir,
        '.drone-agent',
        'personas',
        'reviewer',
        'persona.md'
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('name: reviewer');
      expect(written).toContain('A test persona body.');
      expect(result.toolResult).toBeDefined();
      expect(result.kickMessage).toMatch(/reviewer/);
      const parsed = JSON.parse(result.toolResult ?? '{}');
      expect(parsed.id).toBe('reviewer');
      expect(parsed.scope).toBe('project');
      expect(parsed.filePath).toBe(filePath);
    });
  });

  it('uses input overrides to skip prompts', async () => {
    await withProjectDir(async projectDir => {
      const provider = makeProvider(PERSONA_MD('reviewer'));
      const result = await runWizard(
        {
          scope: 'project',
          id: 'reviewer',
          description: 'reviews code',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([]),
          provider: provider.provider,
        })
      );
      const filePath = path.join(
        projectDir,
        '.drone-agent',
        'personas',
        'reviewer',
        'persona.md'
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('name: reviewer');
      const parsed = JSON.parse(result.toolResult ?? '{}');
      expect(parsed.id).toBe('reviewer');
      expect(parsed.scope).toBe('project');
    });
  });
});

describe('personaCreateWorkflow — validation failures', () => {
  it('throws when LLM output has no frontmatter', async () => {
    await withProjectDir(async projectDir => {
      const provider = makeProvider('just a body, no frontmatter');
      await expect(
        runWizard(
          {
            scope: 'project',
            id: 'reviewer',
            description: 'reviews code',
          },
          makeContext({
            projectDir,
            elicit: scriptedElicit([]),
            provider: provider.provider,
          })
        )
      ).rejects.toThrow(/without YAML frontmatter/);
    });
  });

  it('throws when LLM "name" field slugifies to a different id', async () => {
    await withProjectDir(async projectDir => {
      const provider = makeProvider(PERSONA_MD('wrong-id', 'Wrong'));
      await expect(
        runWizard(
          {
            scope: 'project',
            id: 'reviewer',
            description: 'reviews code',
          },
          makeContext({
            projectDir,
            elicit: scriptedElicit([]),
            provider: provider.provider,
          })
        )
      ).rejects.toThrow(/does not match the requested id/);
    });
  });

  it('throws when LLM omits the name field', async () => {
    await withProjectDir(async projectDir => {
      const provider = makeProvider(
        '---\ndescription: missing name\n---\nbody\n'
      );
      await expect(
        runWizard(
          {
            scope: 'project',
            id: 'reviewer',
            description: 'reviews code',
          },
          makeContext({
            projectDir,
            elicit: scriptedElicit([]),
            provider: provider.provider,
          })
        )
      ).rejects.toThrow(/without a "name" field/);
    });
  });

  it('throws when LLM returns an empty message', async () => {
    await withProjectDir(async projectDir => {
      const provider = makeProvider('');
      await expect(
        runWizard(
          {
            scope: 'project',
            id: 'reviewer',
            description: 'reviews code',
          },
          makeContext({
            projectDir,
            elicit: scriptedElicit([]),
            provider: provider.provider,
          })
        )
      ).rejects.toThrow(/empty response/);
    });
  });

  it('strips stray ``` fences from the LLM output', async () => {
    await withProjectDir(async projectDir => {
      const provider = makeProvider(
        '```markdown\n' + PERSONA_MD('reviewer') + '\n```'
      );
      const result = await runWizard(
        {
          scope: 'project',
          id: 'reviewer',
          description: 'reviews code',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([]),
          provider: provider.provider,
        })
      );
      expect(result.toolResult).toBeDefined();
      const parsed = JSON.parse(result.toolResult ?? '{}');
      expect(parsed.id).toBe('reviewer');
    });
  });
});

describe('personaCreateWorkflow — overwrite prompts', () => {
  it('asks overwriteAtName when the file already exists, accepts "yes", rewrites', async () => {
    await withProjectDir(async projectDir => {
      const personaDir = path.join(projectDir, '.drone-agent', 'personas');
      await mkdir(personaDir, { recursive: true });
      const filePath = await writePersona(
        personaDir,
        'reviewer',
        '---\nname: reviewer\ndescription: OLD\n---\n# OLD body\n'
      );
      const provider = makeProvider(PERSONA_MD('reviewer'));
      const result = await runWizard(
        {
          scope: 'project',
          id: 'reviewer',
          description: 'reviews code',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([{ overwrite: 'yes' }]),
          provider: provider.provider,
        })
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('A test persona body.');
      expect(written).not.toContain('OLD');
      expect(result.toolResult).toBeDefined();
    });
  });

  it('aborts when overwriteAtName is "no"', async () => {
    await withProjectDir(async projectDir => {
      const personaDir = path.join(projectDir, '.drone-agent', 'personas');
      await mkdir(personaDir, { recursive: true });
      const filePath = await writePersona(
        personaDir,
        'reviewer',
        '---\nname: reviewer\ndescription: OLD\n---\n# OLD body\n'
      );
      const provider = makeProvider(PERSONA_MD('reviewer'));
      await expect(
        runWizard(
          {
            scope: 'project',
            id: 'reviewer',
            description: 'reviews code',
          },
          makeContext({
            projectDir,
            elicit: scriptedElicit([{ overwrite: 'no' }]),
            provider: provider.provider,
          })
        )
      ).rejects.toThrow(/Refusing to overwrite/);
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('OLD body');
    });
  });

  it('skips overwriteFinal when overwriteApproved at naming', async () => {
    await withProjectDir(async projectDir => {
      const personaDir = path.join(projectDir, '.drone-agent', 'personas');
      await mkdir(personaDir, { recursive: true });
      const filePath = await writePersona(
        personaDir,
        'reviewer',
        '---\nname: reviewer\ndescription: OLD\n---\n# OLD body\n'
      );
      const provider = makeProvider(PERSONA_MD('reviewer'));
      const result = await runWizard(
        {
          scope: 'project',
          id: 'reviewer',
          description: 'reviews code',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([{ overwrite: 'yes' }]),
          provider: provider.provider,
        })
      );
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('A test persona body.');
      expect(result.toolResult).toBeDefined();
    });
  });

  it('overwriteFinal aborts when no prior approval', async () => {
    await withProjectDir(async projectDir => {
      const personaDir = path.join(projectDir, '.drone-agent', 'personas');
      await mkdir(personaDir, { recursive: true });
      const filePath = path.join(personaDir, 'reviewer', 'persona.md');
      const provider = makeProvider(PERSONA_MD('reviewer'));
      const elicit: DroneElicitation = {
        ask: async (questions: DroneElicitationQuestion[]) => {
          for (const q of questions) {
            if (q.id === 'id') {
              const out: DroneElicitationAnswers = { id: 'reviewer' };
              return out;
            }
            if (q.id === 'description') {
              // Race: file appears mid-wizard.
              await mkdir(path.join(personaDir, 'reviewer'), {
                recursive: true,
              });
              await writeFile(
                filePath,
                '---\nname: reviewer\ndescription: SURPRISE\n---\n# surprise\n',
                'utf-8'
              );
              return { description: 'reviews code' };
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
            provider: provider.provider,
          })
        )
      ).rejects.toThrow(/Refusing to overwrite/);
      const written = await readFile(filePath, 'utf-8');
      expect(written).toContain('SURPRISE');
    });
  });
});

describe('personaCreateWorkflow — wizard model role', () => {
  it('uses the resolved wizard role provider/model for the LLM call', async () => {
    await withProjectDir(async projectDir => {
      const chatMock = () => ({ message: PERSONA_MD('reviewer') });
      const roleProvider: DroneLlmProvider = { chat: async () => chatMock() };
      const caps = new Map<string, unknown>();
      caps.set('llm', {
        resolveModelForRole: (role: string) => {
          expect(role).toBe('wizard');
          return {
            provider: roleProvider,
            providerId: 'anthropic',
            model: 'claude-haiku-4-5',
          };
        },
      });
      caps.set('persona', {
        getWriters: () => {
          const writers = makeWriters(projectDir);
          return [writers.project, writers.user];
        },
        reloadPersonas: async () => {},
      });
      const config = createDefaultAgentConfig();
      const ctx: DroneWorkflowContext = {
        elicit: scriptedElicit([]),
        projectDir,
        config,
        requestCapability: <T>(id: string): T | undefined =>
          caps.get(id) as T | undefined,
        enablePlugin: async () => false,
        agent: async () => {
          throw new Error('ctx.agent not expected in this test');
        },
      };
      const result = await runWizard(
        { scope: 'project', id: 'reviewer', description: 'reviews code' },
        ctx
      );
      expect(result).toBeTruthy();
    });
  });
});

describe('personaCreateWorkflow — missing prerequisites', () => {
  it('throws when the persona capability is unavailable', async () => {
    await withProjectDir(async projectDir => {
      const config = createDefaultAgentConfig();
      const caps = new Map<string, unknown>();
      caps.set('llm', {
        resolveModelForRole: () => ({
          provider: makeProvider(PERSONA_MD('reviewer')).provider,
          providerId: 'test-provider',
          model: 'test-model',
        }),
      });
      // No 'persona' key
      await expect(
        runWizard(
          { scope: 'project', id: 'reviewer', description: 'reviews code' },
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
      ).rejects.toThrow(/requires the persona broker plugin/);
    });
  });

  it('throws when the llm capability is unavailable', async () => {
    await withProjectDir(async projectDir => {
      const config = createDefaultAgentConfig();
      const caps = new Map<string, unknown>();
      caps.set('persona', {
        getWriters: () => [
          {
            id: 'test',
            scope: 'project',
            label: 'Test',
            exists: async () => false,
            writePersona: async () => ({ filePath: '/tmp/test.md' }),
          },
        ],
        reloadPersonas: async () => {},
      });
      await expect(
        runWizard(
          { scope: 'project', id: 'reviewer', description: 'reviews code' },
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
      ).rejects.toThrow(/requires an active LLM provider/);
    });
  });

  it('calls reloadPersonas when the persona capability is offered', async () => {
    await withProjectDir(async projectDir => {
      const provider = makeProvider(PERSONA_MD('reviewer'));
      let reloaded = 0;
      const writers = makeWriters(projectDir);
      const capabilities = new Map<string, unknown>([
        [
          'persona',
          {
            getWriters: () => [writers.project, writers.user],
            reloadPersonas: async () => {
              reloaded += 1;
            },
          },
        ],
      ]);
      const result = await runWizard(
        {
          scope: 'project',
          id: 'reviewer',
          description: 'reviews code',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([]),
          provider: provider.provider,
          capabilities,
        })
      );
      expect(reloaded).toBe(1);
      const loaded = await loadPersonas(projectDir);
      expect(loaded.has('reviewer')).toBe(true);
      expect(result.toolResult).toBeDefined();
    });
  });

  it('does not throw when the persona capability is missing reloadPersonas', async () => {
    await withProjectDir(async projectDir => {
      const provider = makeProvider(PERSONA_MD('reviewer'));
      const writers = makeWriters(projectDir);
      const capabilities = new Map<string, unknown>([
        [
          'persona',
          {
            getWriters: () => [writers.project, writers.user],
            // No reloadPersonas — should be handled gracefully
          },
        ],
      ]);
      const result = await runWizard(
        {
          scope: 'project',
          id: 'reviewer',
          description: 'reviews code',
        },
        makeContext({
          projectDir,
          elicit: scriptedElicit([]),
          provider: provider.provider,
          capabilities,
        })
      );
      expect(result.toolResult).toBeDefined();
    });
  });
});
