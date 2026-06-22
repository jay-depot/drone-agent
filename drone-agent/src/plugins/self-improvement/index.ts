import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DronePlugin } from 'drone-core';
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
      'Records agent insights about personas and skills for later promotion into improvements.',
    defaultEnabled: false,
    dependencies: [
      { id: 'persona', optional: true },
      { id: 'skills', optional: true },
    ],
  },
  register: async registration => {
    const projectDir = process.cwd();

    // ── self-improvement.insight ─────────────────────────────────────
    registration.registerTool({
      name: 'insight',
      description:
        'Record a self-improvement insight about a persona or skill. ' +
        'Insights are stored in a parallel JSON file and are not visible ' +
        'to the agent during normal operation. They will be used in a ' +
        'future phase to drive improvements. Keep the insight to 1-3 sentences.',
      inputSchema: {
        type: 'object',
        properties: {
          targetType: {
            type: 'string',
            enum: ['persona', 'skill'],
            description:
              'Whether this insight is about a persona or a skill.',
          },
          targetId: {
            type: 'string',
            description:
              'The id of the persona or skill this insight applies to.',
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

        // Validate target exists (soft check — only if the relevant plugin is loaded)
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
        } else {
          throw new Error(
            `Invalid targetType "${targetType}". Must be "persona" or "skill".`
          );
        }

        // Write insight to parallel JSON file
        const insightsDir = path.join(
          projectDir,
          INSIGHTS_DIR,
          INSIGHTS_SUBDIR,
          targetType
        );
        const filePath = path.join(insightsDir, `${targetId}.json`);

        await mkdir(insightsDir, { recursive: true });

        let entries: InsightFile = [];
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
        'self-improvement plugin ready (insights stored in .drone-agent/insights/)'
      );
    });
  },
};
