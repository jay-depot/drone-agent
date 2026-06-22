import type { DronePlugin, DronePromptFragment } from 'drone-core';
import { loadSkills, type DroneSkillDefinition } from './loader.js';
import { skillsCreateWorkflow } from './wizard.js';

export type DroneSkillsCapability = {
  /** Get all loaded skills. */
  getSkills: () => DroneSkillDefinition[];
  /** Get a single skill by id, or undefined. */
  getSkill: (id: string) => DroneSkillDefinition | undefined;
  /**
   * Reload skill .md files from disk. Called by the skills.create
   * workflow after writing a new file, and exposed so other plugins
   * (or tests) can force a refresh.
   */
  reloadSkills: () => Promise<void>;
};

export const skillsPlugin: DronePlugin = {
  metadata: {
    id: 'skills',
    name: 'Skills',
    version: '0.1.0',
    description:
      'Loads skill .md files and provides skills.recall for on-demand retrieval.',
    defaultEnabled: false,
  },
  register: async registration => {
    const projectDir = process.cwd();
    let skills = new Map<string, DroneSkillDefinition>();

    // ── Prompt fragment: tells the agent about the skills system ──────
    const skillsFragment: DronePromptFragment = {
      key: 'skills',
      phase: 'header',
      render: async () => {
        if (skills.size === 0) return false;

        const lines: string[] = ['## Skills'];

        for (const skill of skills.values()) {
          const recall = skill.recall.length > 0
            ? ` — ${skill.recall.join('; ')}`
            : '';
          lines.push(`- \`${skill.id}\`: ${skill.description}${recall}`);
        }

        lines.push(
          'Call `skills.recall` with `{"id": "..."}` to load full instructions.'
        );
        return lines.join('\n');
      },
    };

    registration.registerPromptFragment(skillsFragment);

    // ── Offer capability to other plugins ─────────────────────────────
    const capability: DroneSkillsCapability = {
      getSkills: () => Array.from(skills.values()),
      getSkill: (id: string) => skills.get(id),
      reloadSkills: async () => {
        skills = await loadSkills(projectDir);
        registration.logger.info(
          `reloaded ${skills.size} skill(s)`
        );
      },
    };
    registration.offer(capability);

    // ── onPluginsLoaded: load skills ──────────────────────────────────
    registration.hooks.onPluginsLoaded(async () => {
      await capability.reloadSkills();

      if (skills.size > 0) {
        registration.logger.info(
          `loaded ${skills.size} skill(s): ${Array.from(skills.keys()).join(', ')}`
        );
      }
    });

    // ── skills.recall ─────────────────────────────────────────────────
    registration.registerTool({
      name: 'recall',
      description: 'Load a skill body by id. Use when a task matches its recall conditions.',
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
        if (!id) {
          throw new Error('skills.recall requires a non-empty id string.');
        }

        const skill = skills.get(id);
        if (!skill) {
          throw new Error(
            `Unknown skill "${id}". Available skills: ${Array.from(skills.keys()).join(', ')}`
          );
        }

        return JSON.stringify(
          {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            source: skill.source,
            body: skill.body,
          },
          null,
          2
        );
      },
    });

    // ── skills.list ───────────────────────────────────────────────────
    registration.registerTool({
      name: 'list',
      description:
        'List all available skills with their descriptions and recall conditions.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      execute: async () => {
        const all = Array.from(skills.values());
        return JSON.stringify(
          {
            count: all.length,
            skills: all.map(s => ({
              id: s.id,
              name: s.name,
              description: s.description,
              recall: s.recall,
              source: s.source,
              hasBody: s.body.length > 0,
            })),
          },
          null,
          2
        );
      },
    });

    // ── skills.reload ─────────────────────────────────────────────────
    registration.registerTool({
      name: 'reload',
      description:
        'Reload skill .md files from disk. Use after manually writing or editing a skill file.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      execute: async () => {
        await capability.reloadSkills();
        return JSON.stringify(
          {
            count: skills.size,
            skills: Array.from(skills.keys()),
          },
          null,
          2
        );
      },
    });

    // ── skills.create ─────────────────────────────────────────────────
    registration.registerTool({
      name: 'create',
      description:
        'Interactively create a new skill .md file. Asks for scope, id, description, and recall conditions; writes a skeleton file and asks the coding agent to fill in the body.',
      inputSchema: skillsCreateWorkflow.inputSchema ?? {
        type: 'object',
        additionalProperties: false,
      },
      execute: async input => {
        const result = await registration.runWorkflow('skills.create', input);
        return (
          result.toolResult ??
          JSON.stringify({ ok: true, message: 'Workflow completed.' }, null, 2)
        );
      },
    });

    // ── skills.create workflow ────────────────────────────────────────
    registration.registerWorkflow(skillsCreateWorkflow);

    // ── Help snippets ─────────────────────────────────────────────────
    registration.registerHelp(
      '/skills list         List available skills'
    );
    registration.registerHelp(
      '/skills create       Interactive wizard to author a new skill'
    );
    registration.registerHelp(
      '/skills recall <id>  Load full instructions for a skill'
    );
    registration.registerHelp(
      '/skills reload       Reload skill files from disk'
    );

    // ── /skills slash command ─────────────────────────────────────────
    registration.registerSlashCommand({
      command: '/skills',
      description: 'Manage skills: list, create, recall, reload.',
      handler: async ctx => {
        const subcommand = ctx.args[0] ?? '';

        if (subcommand === 'list') {
          ctx.logger.info(await ctx.engine.executeTool('skills.list', {}));
          return true;
        }

        if (subcommand === 'recall') {
          const id = ctx.args.slice(1).join(' ');
          if (!id) {
            ctx.logger.warn(
              'Usage: /skills recall <id>'
            );
            return true;
          }
          ctx.logger.info(await ctx.engine.executeTool('skills.recall', { id }));
          return true;
        }

        if (subcommand === 'reload') {
          ctx.logger.info(await ctx.engine.executeTool('skills.reload', {}));
          return true;
        }

        if (subcommand === 'create') {
          if (!ctx.engine.runWorkflow) {
            ctx.logger.warn('Workflow API not available in this build.');
            return true;
          }
          await ctx.engine.runHooks('onBeforePrompt');
          const result = await ctx.engine.runWorkflow('skills.create', {});
          if (result.toolResult) {
            ctx.logger.info(result.toolResult);
          }
          await ctx.engine.runHooks('onAfterToolCall');
          if (result.kickMessage && ctx.conversation && ctx.sessionManager) {
            ctx.sessionManager.appendUserMessage(result.kickMessage);
            await ctx.engine.runHooks('onBeforePrompt');
            const reply = await ctx.conversation.sendUserMessage(
              result.kickMessage
            );
            if (reply.length > 0) {
              ctx.logger.info(reply);
            }
            await ctx.engine.runHooks('onAfterToolCall');
          }
          return true;
        }

        ctx.logger.warn(
          'Unknown skills command. Try: /skills list, /skills create, /skills recall <id>, /skills reload'
        );
        return true;
      },
    });
  },
};
