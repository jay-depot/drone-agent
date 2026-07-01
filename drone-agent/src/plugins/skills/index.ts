import type {
  DronePlugin,
  DronePromptFragment,
  DroneRecallEnhancer,
  DroneSkillDefinition,
  DroneSkillProvider,
  DroneSkillWriter,
  DroneSkillsCapability,
} from 'drone-core';
import { skillsCreateWorkflow } from './wizard.js';

// Re-export capability types from drone-core for backward compatibility.
export type { DroneSkillsCapability, DroneRecallEnhancer } from 'drone-core';

export const skillsPlugin: DronePlugin = {
  metadata: {
    id: 'skills',
    name: 'Skills',
    version: '0.1.0',
    description:
      'Broker for skill providers. Provides skills.recall, skills.list, skills.reload, skills.create tools.',
    defaultEnabled: false,
    dependencies: [{ id: 'persona', optional: true }],
  },
  register: async registration => {
    const providers: DroneSkillProvider[] = [];
    const writers: DroneSkillWriter[] = [];
    const recallEnhancers: DroneRecallEnhancer[] = [];

    function insertProviderSorted(provider: DroneSkillProvider): void {
      const idx = providers.findIndex(p => p.precedence > provider.precedence);
      if (idx === -1) {
        providers.push(provider);
      } else {
        providers.splice(idx, 0, provider);
      }
    }

    function removeProvider(providerId: string): void {
      const idx = providers.findIndex(p => p.id === providerId);
      if (idx !== -1) {
        providers.splice(idx, 1);
      }
    }

    // ── Writer management ─────────────────────────────────────────────────
    function insertWriterSorted(writer: DroneSkillWriter): void {
      const scopeOrder: Record<string, number> = {
        project: 0,
        user: 1,
        beacon: 2,
        coordinator: 3,
      };
      const order = scopeOrder[writer.scope] ?? 99;
      const idx = writers.findIndex(w => (scopeOrder[w.scope] ?? 99) > order);
      if (idx === -1) {
        writers.push(writer);
      } else {
        writers.splice(idx, 0, writer);
      }
    }

    function removeWriter(writerId: string): void {
      const idx = writers.findIndex(w => w.id === writerId);
      if (idx !== -1) {
        writers.splice(idx, 1);
      }
    }

    function getAllSkills(): DroneSkillDefinition[] {
      const seen = new Set<string>();
      const result: DroneSkillDefinition[] = [];
      for (const provider of providers) {
        for (const skill of provider.getSkills()) {
          if (!seen.has(skill.id)) {
            seen.add(skill.id);
            result.push(skill);
          }
        }
      }
      return result;
    }

    function getSkillById(id: string): DroneSkillDefinition | undefined {
      for (const provider of providers) {
        const skill = provider.getSkill(id);
        if (skill) return skill;
      }
      return undefined;
    }

    const skillsFragment: DronePromptFragment = {
      key: 'skills',
      phase: 'header',
      render: async () => {
        const all = getAllSkills();
        if (all.length === 0) return false;

        const personaCap = registration.request<{
          getFilteredSkills: (
            skills: DroneSkillDefinition[]
          ) => DroneSkillDefinition[];
        }>('persona');
        const visible = personaCap ? personaCap.getFilteredSkills(all) : all;

        if (visible.length === 0) return false;

        const lines: string[] = ['# Skills'];

        for (const skill of visible) {
          lines.push(`## ${skill.id}`);
          lines.push(`- id: ${skill.id}`);
          lines.push(`- description: ${skill.description}`);
          lines.push('- recall when:');
          for (const condition of skill.recall ?? []) {
            lines.push(`  - ${condition}`);
          }
        }

        if (lines.length === 1) {
          // Only "# Skills" — no skills to show
          return false;
        }

        lines.push(
          'Call `skills.recall` with `{"id": "..."}` to load full instructions.'
        );
        return lines.join('\n');
      },
    };

    registration.registerPromptFragment(skillsFragment);

    const capability: DroneSkillsCapability = {
      getSkills: () => getAllSkills(),
      getSkill: (id: string) => getSkillById(id),
      reloadSkills: async () => {
        for (const provider of providers) {
          await provider.reloadSkills();
        }
        registration.logger.info(
          'reloaded skills from ' + providers.length + ' provider(s)'
        );
      },
      registerProvider: (provider: DroneSkillProvider) => {
        insertProviderSorted(provider);
        registration.logger.info(
          'skill provider "' +
            provider.id +
            '" registered (precedence: ' +
            provider.precedence +
            ')'
        );
      },
      unregisterProvider: (providerId: string) => {
        removeProvider(providerId);
        registration.logger.info(
          'skill provider "' + providerId + '" unregistered'
        );
      },
      registerWriter: (writer: DroneSkillWriter) => {
        insertWriterSorted(writer);
        registration.logger.info(
          'skill writer "' +
            writer.id +
            '" registered (scope: ' +
            writer.scope +
            ')'
        );
      },
      unregisterWriter: (writerId: string) => {
        removeWriter(writerId);
        registration.logger.info(
          'skill writer "' + writerId + '" unregistered'
        );
      },
      getWriters: () => [...writers],
      onRecall: (enhancer: DroneRecallEnhancer) => {
        recallEnhancers.push(enhancer);
      },
    };
    registration.offer(capability);

    registration.hooks.onPluginsLoaded(async () => {
      await capability.reloadSkills();
      const all = getAllSkills();
      if (all.length > 0) {
        registration.logger.info(
          'loaded ' + all.length + ' skill(s): ' + all.map(s => s.id).join(', ')
        );
      }
    });

    registration.registerTool({
      name: 'recall',
      description:
        'Load a skill body by id. Use when a task matches its recall conditions.',
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

        const skill = getSkillById(id);
        if (!skill) {
          const all = getAllSkills();
          throw new Error(
            'Unknown skill "' +
              id +
              '". Available skills: ' +
              all.map(s => s.id).join(', ')
          );
        }

        // Run recall enhancers (e.g. self-improvement principles injection)
        let body = skill.body;
        for (const enhancer of recallEnhancers) {
          body = await enhancer(id, body);
        }

        return JSON.stringify(
          {
            id: skill.id,
            name: skill.name,
            description: skill.description,
            source: skill.source,
            body,
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'list',
      description:
        'List all available skills with their descriptions and recall conditions.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
      },
      execute: async () => {
        const all = getAllSkills();
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
        const all = getAllSkills();
        return JSON.stringify(
          {
            count: all.length,
            skills: all.map(s => s.id),
          },
          null,
          2
        );
      },
    });

    registration.registerTool({
      name: 'create',
      description:
        'Interactively create a new skill .md file. Asks for scope, id, description, and recall conditions; writes a skeleton file and asks the coding agent to fill in the body.',
      inputSchema: skillsCreateWorkflow.inputSchema ?? {
        type: 'object',
        additionalProperties: false,
      },
      execute: async input => {
        const result = await registration.runWorkflow('skills__create', input);
        return (
          result.toolResult ??
          JSON.stringify({ ok: true, message: 'Workflow completed.' }, null, 2)
        );
      },
    });

    registration.registerWorkflow(skillsCreateWorkflow);

    registration.registerHelp('/skills list         List available skills');
    registration.registerHelp(
      '/skills create       Interactive wizard to author a new skill'
    );
    registration.registerHelp(
      '/skills recall <id>  Load full instructions for a skill'
    );
    registration.registerHelp(
      '/skills reload       Reload skill files from disk'
    );

    registration.registerSlashCommand({
      command: '/skills',
      description: 'Manage skills: list, create, recall, reload.',
      handler: async ctx => {
        const subcommand = ctx.args[0] ?? '';

        if (subcommand === 'list') {
          ctx.logger.info(await ctx.engine.executeTool('skills__list', {}));
          return true;
        }

        if (subcommand === 'recall') {
          const id = ctx.args.slice(1).join(' ');
          if (!id) {
            ctx.logger.warn('Usage: /skills recall <id>');
            return true;
          }

          // Execute the tool to get skill data
          const result = await ctx.engine.executeTool('skills__recall', { id });
          const skill = JSON.parse(result);

          // Append to conversation context as synthetic tool result
          ctx.sessionManager?.appendToolResult('skills__recall', result);

          // Tell the user it worked (not the full body)
          ctx.logger.info(`Loaded skill: ${skill.name} (${skill.source})`);
          return true;
        }

        if (subcommand === 'reload') {
          ctx.logger.info(await ctx.engine.executeTool('skills__reload', {}));
          return true;
        }

        if (subcommand === 'create') {
          if (!ctx.engine.runWorkflow) {
            ctx.logger.warn('Workflow API not available in this build.');
            return true;
          }
          await ctx.engine.runHooks('onBeforePrompt');
          const result = await ctx.engine.runWorkflow('skills__create', {});
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
