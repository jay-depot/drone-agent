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
  type DroneWorkflowResult,
} from 'drone-core';
import {
  personaCreateWorkflow,
  slugifyPersonaId,
} from '../src/plugins/persona/wizard.js';
import { loadPersonas } from '../src/plugins/persona/loader.js';
import type { DroneWorkflowContext } from 'drone-core';

const PERSONA_MD = (id: string, name?: string) => {
  // Default the display name to the id (slug) so the wizard's
  // validation passes; tests that exercise the "wrong id" path
  // override `name` to a value that slugifies differently.
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
  let current = md;
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

function makeContext(input: {
  projectDir: string;
  elicit: DroneElicitation;
  provider: DroneLlmProvider;
  capabilities?: Map<string, unknown>;
}): DroneWorkflowContext {
  const config = createDefaultAgentConfig();
  const caps = input.capabilities ?? new Map<string, unknown>();
  if (!caps.has('ollama')) {
    caps.set('ollama', { provider: input.provider });
  }
  return {
    elicit: input.elicit,
    projectDir: input.projectDir,
    config,
    requestCapability: <T>(id: string): T | undefined =>
      caps.get(id) as T | undefined,
    enablePlugin: async (_pluginId: string) => false,
  };
}

/**
 * Run the wizard and assert the return value is a DroneWorkflowResult.
 * The wizard's run signature returns the broader `DroneWorkflowRunReturn`
 * union; in practice it always returns an object. Narrowing here keeps
 * the test bodies uncluttered.
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
async function writePersona(personaDir: string, id: string, content: string): Promise<string> {
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
      const filePath = await writePersona(personaDir, 'reviewer', '---\nname: reviewer\ndescription: OLD\n---\n# OLD body\n');
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
      const filePath = await writePersona(personaDir, 'reviewer', '---\nname: reviewer\ndescription: OLD\n---\n# OLD body\n');
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
      const filePath = await writePersona(personaDir, 'reviewer', '---\nname: reviewer\ndescription: OLD\n---\n# OLD body\n');
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
              await mkdir(path.join(personaDir, 'reviewer'), { recursive: true });
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

describe('personaCreateWorkflow — missing prerequisites', () => {
  it('throws when the ollama capability is unavailable', async () => {
    await withProjectDir(async projectDir => {
      const config = createDefaultAgentConfig();
      const caps = new Map<string, unknown>(); // no 'ollama' key
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
          }
        )
      ).rejects.toThrow(/requires the Ollama provider/);
    });
  });

  it('calls reloadPersonas when the persona capability is offered', async () => {
    await withProjectDir(async projectDir => {
      const provider = makeProvider(PERSONA_MD('reviewer'));
      let reloaded = 0;
      const capabilities = new Map<string, unknown>([
        [
          'persona',
          {
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

  it('does not throw when the persona capability is missing', async () => {
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
      expect(result.toolResult).toBeDefined();
    });
  });
});
