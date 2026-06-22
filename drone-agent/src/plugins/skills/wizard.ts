/**
 * Skills-creation wizard workflow.
 *
 * Unlike the persona.create workflow (which uses a direct LLM call to
 * generate the full .md file), skills.create writes a **skeleton** .md
 * file with just the frontmatter filled in and a placeholder body.
 * The coding agent is then instructed (via kickMessage) to explore the
 * codebase and fill in the skill body.
 *
 * Three entry points share this single implementation:
 *   1. LLM tool call: `skills.create` (delegates to `engine.runWorkflow`)
 *   2. TUI slash command: `/skills create`
 *   3. CLI flag: `--workflow skills.create` (with optional `--workflow-arg key=value`)
 *
 * The wizard asks up to four questions in this order:
 *   1. Scope (project | user) — skipped if `input.scope` supplied.
 *   2. Id (freeform) — slugified client-side. Skipped if `input.id` supplied.
 *   3. Description (freeform) — skipped if `input.description` supplied.
 *   4. Recall conditions (freeform) — skipped if `input.recall` supplied.
 *
 * Plus two conditional overwrite prompts:
 *   - `overwriteAtName`: fires if the target file already exists when
 *     the user supplies the id. Records an `overwriteApproved` flag.
 *   - `overwriteFinal`: fires only if the file still exists at final
 *     write time AND `overwriteApproved` is false (e.g. the file
 *     appeared between naming and writing).
 *
 * After writing, the wizard reloads the skill map via the skills
 * plugin's `reloadSkills()` capability and returns a `kickMessage`
 * so the chat assistant can fill in the skill body by exploring the
 * codebase.
 */

import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DroneElicitation,
  DroneLogger,
  DroneWorkflow,
} from 'drone-core';

type SkillsCreateInput = {
  scope?: 'project' | 'user';
  id?: string;
  description?: string;
  recall?: string;
};

type WizardContext = Parameters<DroneWorkflow['run']>[1];

/** Slugify a freeform name into a valid skill id. */
export function slugifySkillId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveLogger(): DroneLogger {
  return {
    info: () => {},
    warn: message => process.stderr.write(`[skills.wizard] ${message}\n`),
    error: message => process.stderr.write(`[skills.wizard] ${message}\n`),
  };
}

async function askScope(
  elicit: DroneElicitation,
  inputScope: 'project' | 'user' | undefined
): Promise<'project' | 'user'> {
  if (inputScope === 'project' || inputScope === 'user') return inputScope;
  const answers = await elicit.ask([
    {
      id: 'scope',
      prompt: 'Where should this skill live?',
      choices: [
        { value: 'project', label: 'Project (./.drone-agent/skills/)' },
        { value: 'user', label: 'User (~/.drone-agent/skills/)' },
      ],
      defaultValue: 'project',
    },
  ]);
  return answers.scope === 'user' ? 'user' : 'project';
}

async function askId(
  elicit: DroneElicitation,
  inputId: string | undefined,
  logger: DroneLogger
): Promise<string> {
  if (typeof inputId === 'string' && inputId.trim().length > 0) {
    return slugifySkillId(inputId.trim());
  }
  let attempts = 0;
  while (attempts < 2) {
    const answers = await elicit.ask([
      {
        id: 'id',
        prompt: 'Name your skill (short, lowercase, hyphenated, e.g. "webapp-testing")',
        freeform: true,
        placeholder: 'my-skill',
        inputLabel: 'Skill id:',
      },
    ]);
    const slug = slugifySkillId(answers.id ?? '');
    if (slug.length > 0) return slug;
    logger.warn(
      `"${answers.id}" doesn't slugify to a usable id; letters, digits, and hyphens only.`
    );
    attempts += 1;
  }
  throw new Error('Skill id cannot be empty.');
}

async function askDescription(
  elicit: DroneElicitation,
  inputDescription: string | undefined,
  logger: DroneLogger
): Promise<string> {
  if (typeof inputDescription === 'string' && inputDescription.trim().length > 0) {
    return inputDescription.trim();
  }
  let attempts = 0;
  while (attempts < 2) {
    const answers = await elicit.ask([
      {
        id: 'description',
        prompt: 'In one or two sentences, what is this skill meant to do?',
        freeform: true,
        placeholder: 'Test web applications using Playwright.',
        inputLabel: 'Description:',
      },
    ]);
    const text = (answers.description ?? '').trim();
    if (text.length > 0) return text;
    logger.warn('Description cannot be empty.');
    attempts += 1;
  }
  throw new Error('Skill description cannot be empty.');
}

async function askRecall(
  elicit: DroneElicitation,
  inputRecall: string | undefined,
  logger: DroneLogger
): Promise<string[]> {
  if (typeof inputRecall === 'string' && inputRecall.trim().length > 0) {
    return inputRecall
      .split('\n')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
  const answers = await elicit.ask([
    {
      id: 'recall',
      prompt:
        'When should the agent be reminded of this skill? Describe one or more conditions, one per line. ' +
        'For example:\n' +
        '  - The user mentions testing, debugging, or verifying a web application\n' +
        '  - The project contains Playwright or browser test configuration',
      freeform: true,
      placeholder:
        'The user mentions testing, debugging, or verifying a web application',
      inputLabel: 'Recall conditions:',
    },
  ]);
  const raw = (answers.recall ?? '').trim();
  if (raw.length === 0) {
    logger.warn('No recall conditions provided — the skill will not be automatically suggested.');
    return [];
  }
  return raw
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

async function askOverwrite(
  elicit: DroneElicitation,
  logger: DroneLogger,
  filePath: string,
  id: string,
  promptSuffix: string
): Promise<boolean> {
  logger.warn(`A skill file already exists at ${filePath}.`);
  const answers = await elicit.ask([
    {
      id: 'overwrite',
      prompt: `A skill named "${id}" already exists at ${filePath}. Overwrite it? (${promptSuffix})`,
      choices: [
        { value: 'yes', label: 'Yes, overwrite' },
        { value: 'no', label: 'No, cancel' },
      ],
      defaultValue: 'no',
    },
  ]);
  return answers.overwrite === 'yes';
}

/**
 * Resolve the skills plugin capability so we can reload the
 * skill map after writing. Returns `undefined` if the skills
 * plugin isn't available (which would be a wiring bug — the wizard
 * is part of the skills plugin — but we handle it gracefully).
 */
function resolveSkillsCapability(
  ctx: WizardContext
):
  | { reloadSkills: () => Promise<void> }
  | undefined {
  const cap = ctx.requestCapability<{
    reloadSkills?: () => Promise<void>;
  }>('skills');
  if (!cap || typeof cap.reloadSkills !== 'function') return undefined;
  return { reloadSkills: cap.reloadSkills };
}

function buildSkeletonMd(
  id: string,
  description: string,
  recall: string[]
): string {
  const recallLines = recall.length > 0
    ? recall.map(r => `  - ${r}`).join('\n')
    : '  - <TODO: add recall conditions>';

  return [
    '---',
    `name: ${id}`,
    `description: '${description}'`,
    'recall:',
    recallLines,
    'model-invocation: true',
    '---',
    `# ${id.charAt(0).toUpperCase() + id.slice(1)}`,
    '',
    '<!-- TODO: The coding agent should fill in this body by exploring the codebase. -->',
    '',
    '## Overview',
    '',
    '<Describe what this skill does and when to use it.>',
    '',
    '## Instructions',
    '',
    '<Provide step-by-step instructions, examples, and patterns.>',
    '',
    '## Examples',
    '',
    '<Show concrete examples of how to apply this skill.>',
    '',
  ].join('\n');
}

export const skillsCreateWorkflow: DroneWorkflow = {
  name: 'create',
  description:
    'Interactive wizard to author a new skill .md file. Asks for scope, id, description, and recall conditions; writes a skeleton file and asks the coding agent to fill in the body.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        description: 'Optional — skip the first prompt. "project" or "user".',
      },
      id: {
        type: 'string',
        description:
          'Optional — skip the id prompt. Will be slugified client-side.',
      },
      description: {
        type: 'string',
        description: 'Optional — skip the description prompt.',
      },
      recall: {
        type: 'string',
        description:
          'Optional — skip the recall prompt. One recall condition per line.',
      },
    },
    additionalProperties: false,
  },
  run: async (rawInput, ctx) => {
    const input = (rawInput ?? {}) as SkillsCreateInput;
    const logger = resolveLogger();

    // 1. Scope
    const scope = await askScope(ctx.elicit, input.scope);

    // 2. Id (slugified)
    const id = await askId(ctx.elicit, input.id, logger);

    // 3. Existence check #1
    const targetRoot =
      scope === 'user' ? os.homedir() : ctx.projectDir;
    const targetDir = path.join(targetRoot, '.drone-agent', 'skills');
    const filePath = path.join(targetDir, `${id}.md`);
    let overwriteApproved = false;
    if (await fileExists(filePath)) {
      overwriteApproved = await askOverwrite(
        ctx.elicit,
        logger,
        filePath,
        id,
        'existing file'
      );
      if (!overwriteApproved) {
        throw new Error(
          `Refusing to overwrite existing skill at ${filePath}. Pick a different id, or delete the file first.`
        );
      }
    }

    // 4. Description
    const description = await askDescription(
      ctx.elicit,
      input.description,
      logger
    );

    // 5. Recall conditions
    const recall = await askRecall(ctx.elicit, input.recall, logger);

    // 6. Build skeleton
    const skeleton = buildSkeletonMd(id, description, recall);

    // 7. Existence check #2 (race condition)
    if (!overwriteApproved && (await fileExists(filePath))) {
      const reApproved = await askOverwrite(
        ctx.elicit,
        logger,
        filePath,
        id,
        'file appeared during this wizard'
      );
      if (!reApproved) {
        throw new Error(
          `Refusing to overwrite skill at ${filePath}; the file appeared during the wizard.`
        );
      }
    }

    // 8. Write
    await mkdir(targetDir, { recursive: true });
    await writeFile(filePath, skeleton, 'utf-8');

    // 9. Reload
    const skillsCap = resolveSkillsCapability(ctx);
    if (skillsCap) {
      try {
        await skillsCap.reloadSkills();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`reloadSkills after write failed: ${msg}`);
      }
    }

    // The kick message instructs the assistant to fill in the skill body
    // by exploring the codebase. The assistant should NOT run any other
    // tools or take further action beyond writing the skill body.
    const recallNote = recall.length > 0
      ? `The skill will be suggested when the user mentions: ${recall.join('; ')}.`
      : 'No recall conditions were set; the skill will not be automatically suggested.';
    const kickMessage =
      `Skill "${id}" (${description}) is now available — the skeleton file ` +
      `was written to ${filePath}. ${recallNote} ` +
      `The active skill list has been reloaded. ` +
      `Please read the skeleton file, explore the codebase to understand the context, ` +
      `and fill in the skill body with instructions, examples, and patterns. ` +
      `When done, call \`skills.reload\` to refresh the skill list. ` +
      `Briefly describe what was created in one or two sentences and stop. ` +
      `Do not run any other tools or take further action.`;

    const toolResult = JSON.stringify(
      {
        id,
        scope,
        filePath,
        description,
        recallCount: recall.length,
        isSkeleton: true,
      },
      null,
      2
    );

    return { kickMessage, toolResult };
  },
};
