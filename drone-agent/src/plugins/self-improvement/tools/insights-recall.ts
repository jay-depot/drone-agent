import type {
  DroneInsightStorageEngine,
  DronePersonaCapability,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import { validateTarget } from '../validation.js';
import { resolveInsightEngine } from '../capability.js';

export function createInsightsRecallTool(
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined,
  defaultInsightEngine: DroneInsightStorageEngine
): DroneToolDefinition {
  return {
    name: 'insights-recall',
    defaultHidden: true,
    description:
      'Read all insights for a specific target (persona, skill, or project).',
    inputSchema: {
      type: 'object',
      properties: {
        targetType: {
          type: 'string',
          enum: ['persona', 'skill', 'project'],
          description: 'The type of target to read insights for.',
        },
        targetId: {
          type: 'string',
          description: 'The id of the persona, skill, or project category.',
        },
      },
      required: ['targetType', 'targetId'],
      additionalProperties: false,
    },
    execute: async input => {
      const targetType = input.targetType as string;
      const targetId = (input.targetId as string).trim().toLowerCase();
      validateTarget(targetType, targetId, personaCap(), skillsCap());

      const engine = resolveInsightEngine(
        targetType,
        targetId,
        defaultInsightEngine,
        personaCap(),
        skillsCap()
      );
      const entries = await engine.readInsights(targetType, targetId);
      return JSON.stringify({ targetType, targetId, entries }, null, 2);
    },
  };
}
