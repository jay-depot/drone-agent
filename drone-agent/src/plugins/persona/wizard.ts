/**
 * Persona-creation wizard workflow.
 *
 * Triggers an interactive multi-step dialog with the user, asks an LLM
 * to author a persona .md file based on their description, validates
 * the output, and writes it to the selected scope via the persona
 * broker's registered writers.
 *
 * Three entry points share this single implementation:
 *   1. LLM tool call: `persona.create` (delegates to `engine.runWorkflow`)
 *   2. TUI slash command: `/persona create`
 *   3. CLI flag: `--workflow persona.create` (with optional `--workflow-arg key=value`)
 *
 * The wizard asks up to four questions in this order:
 *   1. Scope (project | user | beacon | coordinator) — dynamically built
 *      from registered writers. Skipped if `input.scope` supplied.
 *   2. Id (freeform) — slugified client-side. Skipped if `input.id` supplied.
 *   3. Description (freeform) — skipped if `input.description` supplied.
 *
 * Plus two conditional overwrite prompts:
 *   - `overwriteAtName`: fires if the target already exists when
 *     the user supplies the id. Records an `overwriteApproved` flag.
 *   - `overwriteFinal`: fires only if the target still exists at final
 *     write time AND `overwriteApproved` is false (e.g. the asset
 *     appeared between naming and writing).
 *
 * After writing, the wizard reloads the persona map via the persona
 * plugin's `reloadPersonas()` capability and returns a `kickMessage`
 * so the chat assistant can summarise the result for the user.
 */

import type {
  DroneElicitation,
  DroneLlmProvider,
  DroneLogger,
  DronePersonaCapability,
  DronePersonaDefinition,
  DronePersonaWriter,
  DroneWorkflow,
} from 'drone-core';
import { parsePersonaMd } from './loader.js';

type PersonaCreateInput = {
  scope?: string;
  id?: string;
  description?: string;
};

/** Slugify a freeform name into a valid persona id. */
export function slugifyPersonaId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function buildPersonaSystemPrompt(): string {
  return [
    'You write persona .md files for a coding agent.',
    '',
    'The expected format is a YAML frontmatter block followed by an optional body:',
    '',
    '---',
    'name: <name>',
    'description: <one-line summary>',
    'color: <optional TUI tint, use "#rrggbb" format only. For example, "#00ffff". Prefer lighter colors for better contrast with most terminals.>',
    'fragments:',
    '  - <optional list of short prompt fragments>',
    'premountedTools:',
    '  <pluginId>:',
    '    - <toolName>',
    '    - <toolName>',
    '---',
    '<optional body — becomes the systemPromptOverride>',
    '',
    'Rules:',
    '- Output ONLY the raw .md file contents.',
    '- No prose, no commentary, no code fences.',
    '- The first non-empty line must be the `---` that opens the frontmatter.',
    '- Keep the body concise (≤200 words).',
    "- Pick a `color` that fits the persona's vibe (omit the field if uncertain).",
    '- Use `fragments:` only if you have 2+ short, actionable directives.',
    '- Use `premountedTools:` only if the persona needs specific tools always visible, mapped by plugin id to tool names (e.g. `file: [read, list, apply_diff]`).',
    '- Omit `premountedTools:` if the persona does not need any tools pre-mounted.',
    '- The `name` field MUST be exactly the id provided in the user prompt (lowercase, hyphenated).',
  ].join('\n');
}

function stripCodeFences(raw: string): string {
  let text = raw.trim();
  // Strip a single wrapping ``` fence pair if the model emitted one.
  if (text.startsWith('```')) {
    // Drop the first line (``` or ```markdown).
    const firstNewline = text.indexOf('\n');
    if (firstNewline !== -1) {
      text = text.slice(firstNewline + 1);
    }
    if (text.endsWith('```')) {
      text = text.slice(0, -3).trimEnd();
    }
  }
  return text;
}

function validatePersonaOutput(
  id: string,
  candidate: string,
  logger: DroneLogger
): DronePersonaDefinition {
  if (!candidate.includes('---')) {
    throw new Error(
      `LLM returned a persona without YAML frontmatter; aborting. First 80 chars: ${candidate.slice(0, 80)}`
    );
  }
  const definition = parsePersonaMd(id, candidate);
  // We need a way to distinguish "LLM explicitly set name=id" from
  // "parser fell back to using id as name". The parser doesn't track
  // this, so check the raw candidate for a `name:` line.
  const hasNameLine = /^name:\s*\S+/m.test(candidate);
  if (!hasNameLine) {
    throw new Error(
      `LLM returned a persona without a "name" field in frontmatter; aborting.`
    );
  }
  const slugFromName = slugifyPersonaId(definition.name);
  if (slugFromName !== id) {
    throw new Error(
      `LLM returned a persona whose "name" field ("${definition.name}", slugifies to "${slugFromName}") does not match the requested id ("${id}").`
    );
  }
  if (!definition.description || definition.description.trim().length === 0) {
    logger.warn(
      `persona "${id}" has an empty description — accepting, but the wizard should require a non-empty description.`
    );
  }
  return definition;
}

async function askId(
  elicit: DroneElicitation,
  inputId: string | undefined,
  logger: DroneLogger
): Promise<string> {
  if (typeof inputId === 'string' && inputId.trim().length > 0) {
    return slugifyPersonaId(inputId.trim());
  }
  let attempts = 0;
  while (attempts < 2) {
    const answers = await elicit.ask([
      {
        id: 'id',
        prompt:
          'Name your persona (short, lowercase, hyphenated, e.g. "strict-reviewer")',
        freeform: true,
        placeholder: 'my-persona',
        inputLabel: 'Persona id:',
      },
    ]);
    const slug = slugifyPersonaId(answers.id ?? '');
    if (slug.length > 0) return slug;
    logger.warn(
      `"${answers.id}" doesn't slugify to a usable id; letters, digits, and hyphens only.`
    );
    attempts += 1;
  }
  throw new Error('Persona id cannot be empty.');
}

async function askDescription(
  elicit: DroneElicitation,
  inputDescription: string | undefined,
  logger: DroneLogger
): Promise<string> {
  if (
    typeof inputDescription === 'string' &&
    inputDescription.trim().length > 0
  ) {
    return inputDescription.trim();
  }
  let attempts = 0;
  while (attempts < 2) {
    const answers = await elicit.ask([
      {
        id: 'description',
        prompt: 'In one or two sentences, what is this persona meant to do?',
        freeform: true,
        placeholder: 'Reviews code with a focus on edge cases and naming.',
        inputLabel: 'Description:',
      },
    ]);
    const text = (answers.description ?? '').trim();
    if (text.length > 0) return text;
    logger.warn('Description cannot be empty.');
    attempts += 1;
  }
  throw new Error('Persona description cannot be empty.');
}

async function askScope(
  elicit: DroneElicitation,
  inputScope: string | undefined,
  writers: DronePersonaWriter[]
): Promise<DronePersonaWriter> {
  if (inputScope) {
    const match = writers.find(w => w.scope === inputScope);
    if (match) return match;
    // If input scope doesn't match any writer, fall through to prompt
  }
  const answers = await elicit.ask([
    {
      id: 'scope',
      prompt: 'Where should this persona live?',
      choices: writers.map(w => ({
        value: w.scope,
        label: w.label,
      })),
      defaultValue: writers[0]?.scope ?? 'project',
    },
  ]);
  const selected = writers.find(w => w.scope === answers.scope);
  return selected ?? writers[0];
}

function resolveLogger(): DroneLogger {
  return {
    info: () => {},
    warn: message => process.stderr.write(`[persona.wizard] ${message}\n`),
    error: message => process.stderr.write(`[persona.wizard] ${message}\n`),
  };
}

async function askOverwrite(
  elicit: DroneElicitation,
  logger: DroneLogger,
  id: string,
  scope: string,
  promptSuffix: string
): Promise<boolean> {
  logger.warn(`A persona named "${id}" already exists at scope "${scope}".`);
  const answers = await elicit.ask([
    {
      id: 'overwrite',
      prompt: `A persona named "${id}" already exists at scope "${scope}". Overwrite it? (${promptSuffix})`,
      choices: [
        { value: 'yes', label: 'Yes, overwrite' },
        { value: 'no', label: 'No, cancel' },
      ],
      defaultValue: 'no',
    },
  ]);
  return answers.overwrite === 'yes';
}

export const personaCreateWorkflow: DroneWorkflow = {
  name: 'create',
  description:
    'Interactive wizard to author a new persona .md file. Asks for scope, id, and description; has the LLM write the persona; validates and writes it to the selected scope.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        description:
          'Optional — skip the first prompt. One of: project, user, beacon, coordinator.',
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
    },
    additionalProperties: false,
  },
  run: async (rawInput, ctx) => {
    const input = (rawInput ?? {}) as PersonaCreateInput;
    const logger = resolveLogger();

    // Resolve the persona capability to get registered writers
    const personaCap = ctx.requestCapability<DronePersonaCapability>('persona');
    if (!personaCap) {
      throw new Error(
        'persona.create workflow requires the persona broker plugin to be enabled.'
      );
    }
    const writers = personaCap.getWriters();
    if (writers.length === 0) {
      throw new Error(
        'No persona writers are registered. Enable at least one persona provider plugin (e.g. persona-provider-project).'
      );
    }

    // 1. Scope — pick a writer
    const writer = await askScope(ctx.elicit, input.scope, writers);

    // 2. Id (slugified)
    const id = await askId(ctx.elicit, input.id, logger);

    // 3. Existence check #1
    let overwriteApproved = false;
    if (await writer.exists(id)) {
      overwriteApproved = await askOverwrite(
        ctx.elicit,
        logger,
        id,
        writer.scope,
        'existing asset'
      );
      if (!overwriteApproved) {
        throw new Error(
          `Refusing to overwrite existing persona "${id}" at scope "${writer.scope}". Pick a different id, or delete the file first.`
        );
      }
    }

    // 4. Description
    const description = await askDescription(
      ctx.elicit,
      input.description,
      logger
    );

    // 5. LLM call (fresh — no tools, no conversation history).
    const ollama = ctx.requestCapability<{
      provider: DroneLlmProvider;
    }>('ollama');
    if (!ollama) {
      throw new Error(
        'persona.create workflow requires the Ollama provider; enable the ollama plugin.'
      );
    }
    const candidate = await ollama.provider.chat({
      model: ctx.config.ollama.model,
      tools: [],
      messages: [
        { role: 'system', content: buildPersonaSystemPrompt() },
        {
          role: 'user',
          content: `id: ${id}\ndescription: ${description}\n\nWrite the .md file for this persona now.`,
        },
      ],
    });

    const candidateText = stripCodeFences(candidate.message ?? '');
    if (candidateText.length === 0) {
      throw new Error(
        'LLM returned an empty response for the persona; aborting.'
      );
    }

    // 6. Validation
    const definition = validatePersonaOutput(id, candidateText, logger);

    // 7. Existence check #2 (race condition)
    if (!overwriteApproved && (await writer.exists(id))) {
      const reApproved = await askOverwrite(
        ctx.elicit,
        logger,
        id,
        writer.scope,
        'asset appeared during this wizard'
      );
      if (!reApproved) {
        throw new Error(
          `Refusing to overwrite persona "${id}" at scope "${writer.scope}"; the asset appeared during the wizard.`
        );
      }
    }

    // 8. Write via the selected writer
    const { filePath } = await writer.writePersona(id, candidateText);

    // 9. Reload
    try {
      await personaCap.reloadPersonas();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`reloadPersonas after write failed: ${msg}`);
    }

    const colorNote = definition.uiColor
      ? `A UI color (${definition.uiColor}) is set; the TUI theme will tint when this persona is active.`
      : `No UI color is set; the user can edit the frontmatter to add one (e.g. \`color: cyan\`).`;
    const kickMessage =
      `Persona "${definition.name}" (id: ${id}) is now available — the file ` +
      `was written to ${filePath}. ${colorNote} The active persona has NOT ` +
      `been changed; the user can switch with \`/persona select ${id}\` ` +
      `whenever they want. Briefly describe what was created in one or two ` +
      `sentences and stop. Do not run any other tools or take further action.`;
    const toolResult = JSON.stringify(
      {
        id,
        name: definition.name,
        scope: writer.scope,
        filePath,
        description,
        hasOverride: Boolean(definition.systemPromptOverride),
        fragmentCount: definition.promptFragments?.length ?? 0,
        uiColor: definition.uiColor ?? null,
      },
      null,
      2
    );

    return { kickMessage, toolResult };
  },
};
