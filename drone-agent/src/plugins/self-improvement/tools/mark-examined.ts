import type {
  DroneInsightStorageEngine,
  DronePersonaCapability,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import { trimOrEmpty, validateTarget } from '../validation.js';
import { resolveInsightEngine } from '../capability.js';

export function createMarkExaminedTool(
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined,
  defaultInsightEngine: DroneInsightStorageEngine
): DroneToolDefinition {
  return {
    name: 'mark_examined',
    description:
      'Mark all insights for a target as examined "as of now" (sets lastExamined on every entry). ' +
      'Intended for the insight-review/promotion process. Hidden by default; premount to use.',
    defaultHidden: true,
    inputSchema: {
      type: 'object',
      properties: {
        targetType: {
          type: 'string',
          enum: ['persona', 'skill', 'project'],
          description: 'Target type.',
        },
        targetId: {
          type: 'string',
          description: 'Target id.',
        },
      },
      required: ['targetType', 'targetId'],
      additionalProperties: false,
    },
    execute: async input => {
      const targetType = input.targetType as string;
      const targetId = trimOrEmpty(input.targetId).toLowerCase();

      validateTarget(targetType, targetId, personaCap(), skillsCap());

      const engine = resolveInsightEngine(
        targetType,
        targetId,
        defaultInsightEngine,
        personaCap(),
        skillsCap()
      );
      const result = await engine.markInsightsExamined(targetType, targetId);

      return JSON.stringify(
        {
          ok: true,
          targetType,
          targetId,
          markedCount: result.markedCount,
          message: `Marked ${result.markedCount} insight(s) as examined via ${engine.providerId}.`,
        },
        null,
        2
      );
    },
  };
}
