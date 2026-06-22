import type { DronePlugin, DronePromptFragment } from 'drone-core';
import { loadSkills, type DroneSkillDefinition } from './loader.js';

export type DroneSkillsCapability = {
  /** Get all loaded skills. */
  getSkills: () => DroneSkillDefinition[];
  /** Get a single skill by id, or undefined. */
  getSkill: (id: string) => DroneSkillDefinition | undefined;
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
    };
    registration.offer(capability);

    // ── onPluginsLoaded: load skills ──────────────────────────────────
    registration.hooks.onPluginsLoaded(async () => {
      skills = await loadSkills(projectDir);

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
  },
};
