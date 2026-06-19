import type { DronePlugin, DronePromptFragment } from 'drone-core';
import { loadSkills, type DroneSkillDefinition } from './loader.js';

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

        const lines: string[] = [
          '## Available Skills',
          '',
          'The following skills are available. Each skill has recall conditions that describe when it is relevant.',
          "When you encounter a task that matches a skill's recall conditions, use `skills.recall` with the skill id to load its full instructions.",
          '',
        ];

        for (const skill of skills.values()) {
          lines.push(`### ${skill.name}`);
          lines.push(`**ID**: \`${skill.id}\``);
          lines.push(`**Description**: ${skill.description}`);
          if (skill.recall.length > 0) {
            lines.push('**Recall when**:');
            for (const condition of skill.recall) {
              lines.push(`- ${condition}`);
            }
          }
          lines.push('');
        }

        lines.push(
          'To load a skill, call `skills.recall` with `{"id": "<skill-id>"}`.'
        );
        lines.push(
          'The tool returns the full skill body with step-by-step instructions.'
        );

        return lines.join('\n');
      },
    };

    registration.registerPromptFragment(skillsFragment);

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
      description:
        "Load the full instructions for a skill by its id. Call this when a task matches a skill's recall conditions.",
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description:
              'The skill id to recall. Use skills.list to see available skills.',
          },
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
