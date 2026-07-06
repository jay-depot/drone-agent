import type {
  DroneInsightStorageEngine,
  DronePersonaCapability,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import { validateTarget } from '../validation.js';
import { resolveInsightEngine } from '../capability.js';
import { incrementInsightCount } from '../state.js';

export function createInsightTool(
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined,
  defaultInsightEngine: DroneInsightStorageEngine
): DroneToolDefinition {
  return {
    name: 'insight',
    description:
      'Record a self-improvement insight about a persona, skill, or the project. ' +
      'Whenever you encounter an issue, gap, or opportunity related ' +
      'to a persona, skill, or the project itself, use this tool to log it as an insight. ' +
      'Do this proactively as you work, and do not worry about creating ' +
      'too many insights. They will be evaluated all together all at once ' +
      'to look for patterns, so more is better! Insights should be ' +
      'short and focused on a single observation or issue. ' +
      'Use `persona__list` and `skills__list` to discover valid IDs before calling this tool.',
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
            'Use `persona__list` or `skills__list` to discover valid IDs. ' +
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

      if (!insight) {
        throw new Error('insight must be a non-empty string.');
      }

      validateTarget(targetType, targetId, personaCap(), skillsCap());

      const engine = resolveInsightEngine(
        targetType,
        targetId,
        defaultInsightEngine,
        personaCap(),
        skillsCap()
      );
      const result = await engine.recordInsight(targetType, targetId, insight);
      incrementInsightCount();

      return JSON.stringify(
        {
          ok: true,
          targetType,
          targetId,
          entryCount: result.entryCount,
          message: `Insight recorded for ${targetType} "${targetId}" via ${engine.providerId}.`,
        },
        null,
        2
      );
    },
  };
}
