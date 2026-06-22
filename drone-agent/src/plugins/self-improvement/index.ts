import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DronePlugin, DronePromptFragment } from 'drone-core';
import type { DronePersonaCapability } from '../persona/index.js';
import type { DroneSkillsCapability } from '../skills/index.js';

const INSIGHTS_DIR = '.drone-agent';
const INSIGHTS_SUBDIR = 'insights';

type InsightEntry = {
  timestamp: string;
  insight: string;
};

type InsightFile = InsightEntry[];

export const selfImprovementPlugin: DronePlugin = {
  metadata: {
    id: 'self-improvement',
    name: 'Self-Improvement',
    version: '0.1.0',
    description:
      'Records agent insights about personas, skills, or the project for later promotion into improvements.',
    defaultEnabled: false,
    dependencies: [
      { id: 'persona', optional: true },
      { id: 'skills', optional: true },
    ],
  },
  register: async registration => {
    const projectDir = process.cwd();

    // ── Prompt fragment: show current active persona ─────────────────
    const insightFragment: DronePromptFragment = {
      key: 'insight-targets',
      phase: 'header',
      render: async () => {
        const lines: string[] = [];

        const personaCap =
          registration.request<DronePersonaCapability>('persona');
        const activePersona = personaCap?.getActivePersona();
        if (activePersona) {
          lines.push(
            `Current active persona: \`${activePersona.id}\`. ` +
              `Use \`self-improvement.insight\` with \`targetType: "persona"\` to record insights about it.`
          );
        }

        lines.push(
          'Use `persona.list` to see all available personas and `skills.list` to see available skills.'
        );

        return lines.join('\n');
      },
    };

    registration.registerPromptFragment(insightFragment);

    // ── self-improvement.insight ─────────────────────────────────────
    registration.registerTool({
      name: 'insight',
      description:
        'Record a self-improvement insight about a persona, skill, or the project. ' +
        'Whenever you encounter an issue, gap, or opportunity related ' +
        'to a persona, skill, or the project itself, use this tool to log it as an insight. ' +
        'Do this proactively as you work, and do not worry about creating ' +
        'too many insights. They will be evaluated all together all at once ' +
        'to look for patterns, so more is better! Insights should be ' +
        'short and focused on a single observation or issue. ' +
        'Use `persona.list` and `skills.list` to discover valid IDs before calling this tool.',
      inputSchema: {
        type: 'object',
        properties: {
          targetType: {
            type: 'string',
            enum: ['persona', 'skill', 'project'],
            description:
              'Whether this insight is about a persona, a skill, or the project.',
          },
          targetId: {
            type: 'string',
            description:
              'The id of the persona or skill this insight applies to. ' +
              'Use `persona.list` or `skills.list` to discover valid IDs. ' +
              'For project insights, use a descriptive category like "architecture" or "workflow".',
          },
          insight: {
            type: 'string',
            description:
              'A short (1-3 sentence) observation about what could be ' +
              'improved, what worked well, or what is missing.',
          },
        },
        required: ['targetType', 'targetId', 'insight'],
        additionalProperties: false,
      },
      execute: async input => {
        const targetType = input.targetType as string;
        const targetId = (input.targetId as string).trim().toLowerCase();
        const insight = (input.insight as string).trim();

        if (!targetId) {
          throw new Error('targetId must be a non-empty string.');
        }
        if (!insight) {
          throw new Error('insight must be a non-empty string.');
        }

        if (targetType === 'persona') {
          const personaCap = registration.request<DronePersonaCapability>('persona');
          if (personaCap) {
            const persona = personaCap
              .getPersonas()
              .find(p => p.id === targetId);
            if (!persona) {
              throw new Error(
                `Unknown persona "${targetId}". Available: ${personaCap
                  .getPersonas()
                  .map(p => p.id)
                  .join(', ')}`
              );
            }
          }
          // If persona plugin isn't loaded, skip validation — just write
        } else if (targetType === 'skill') {
          const skillsCap = registration.request<DroneSkillsCapability>('skills');
          if (skillsCap) {
            const skill = skillsCap.getSkill(targetId);
            if (!skill) {
              throw new Error(
                `Unknown skill "${targetId}". Available: ${skillsCap
                  .getSkills()
                  .map(s => s.id)
                  .join(', ')}`
              );
            }
          }
        } else if (targetType === 'project') {
          // No validation needed — the project is always a valid target
        } else {
          throw new Error(
            `Invalid targetType "${targetType}". Must be "persona", "skill", or "project".`
          );
        }

        // Determine base directory based on scope/source
        let baseDir = projectDir;
        if (targetType === 'persona') {
          const personaCap = registration.request<DronePersonaCapability>('persona');
          if (personaCap) {
            const persona = personaCap
              .getPersonas()
              .find(p => p.id === targetId);
            if (persona?.scope === 'user') {
              baseDir = os.homedir();
            }
          }
        } else if (targetType === 'skill') {
          const skillsCap = registration.request<DroneSkillsCapability>('skills');
          if (skillsCap) {
            const skill = skillsCap.getSkill(targetId);
            if (skill?.source === 'user') {
              baseDir = os.homedir();
            }
          }
        }

        // Write insight to the appropriate location
        let insightsDir: string;
        let filePath: string;

        if (targetType === 'persona') {
          // Persona insights live in <personaDir>/<id>/insights/insights.json
          const personaDir = path.join(baseDir, '.drone-agent', 'personas', targetId);
          insightsDir = path.join(personaDir, 'insights');
          filePath = path.join(insightsDir, 'insights.json');
        } else if (targetType === 'skill') {
          // Check if this skill is owned by a persona
          const skillsCap = registration.request<DroneSkillsCapability>('skills');
          const skill = skillsCap?.getSkill(targetId);
          if (skill?.personaId) {
            // Persona-owned skill insights live in <personaDir>/<id>/insights/<skill-id>.json
            const personaDir = path.join(baseDir, '.drone-agent', 'personas', skill.personaId);
            insightsDir = path.join(personaDir, 'insights');
            filePath = path.join(insightsDir, `${targetId}.json`);
          } else {
            // Standalone skill insights live in .drone-agent/insights/skill/<id>.json
            insightsDir = path.join(
              baseDir,
              INSIGHTS_DIR,
              INSIGHTS_SUBDIR,
              targetType
            );
            filePath = path.join(insightsDir, `${targetId}.json`);
          }
        } else {
          // Project insights live in .drone-agent/insights/project/<id>.json
          insightsDir = path.join(
            baseDir,
            INSIGHTS_DIR,
            INSIGHTS_SUBDIR,
            targetType
          );
          filePath = path.join(insightsDir, `${targetId}.json`);
        }

        await mkdir(insightsDir, { recursive: true });

        let entries: InsightFile;
        try {
          const raw = await readFile(filePath, 'utf-8');
          entries = JSON.parse(raw) as InsightFile;
          if (!Array.isArray(entries)) entries = [];
        } catch {
          // File doesn't exist or is corrupt — start fresh
          entries = [];
        }

        const newEntry: InsightEntry = {
          timestamp: new Date().toISOString(),
          insight,
        };
        entries.push(newEntry);

        await writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');

        return JSON.stringify(
          {
            ok: true,
            targetType,
            targetId,
            entryCount: entries.length,
            message: `Insight recorded for ${targetType} "${targetId}".`,
          },
          null,
          2
        );
      },
    });

    // ── onPluginsLoaded: log status ──────────────────────────────────
    registration.hooks.onPluginsLoaded(async () => {
      registration.logger.info(
        'self-improvement plugin ready (persona insights stored in .drone-agent/personas/<id>/insights/; skill/project insights stored in .drone-agent/insights/)'
      );
    });
  },
};
