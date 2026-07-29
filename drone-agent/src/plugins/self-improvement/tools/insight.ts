import { SelfImprovementInsightBlock } from '../../../tui/components/SelfImprovementInsightBlock.js';
import type {
  DroneInsightStorageEngine,
  DronePersonaCapability,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import {
  VALID_TARGET_TYPES,
  isValidTargetType,
  validateTarget,
  type TargetType,
} from '../validation.js';
import { resolveInsightEngine } from '../capability.js';
import { incrementInsightCount, insightEngines } from '../state.js';

export function createInsightTool(
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined,
  defaultInsightEngine: DroneInsightStorageEngine
): DroneToolDefinition {
  return {
    name: 'insight',
    description:
      'Manage self-improvement insights. ' +
      'Use action="record" to log a new insight, action="list" to browse all insight files, ' +
      'action="recall" to read all insights for a specific target.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['record', 'list', 'recall'],
          description:
            'What to do: record (log new), list (browse files), recall (read entries).',
        },
        targetType: {
          type: 'string',
          enum: ['persona', 'skill', 'project'],
          description: 'Target type (required for record and recall).',
        },
        targetId: {
          type: 'string',
          description: 'Target id (required for record and recall).',
        },
        insight: {
          type: 'string',
          description: 'Insight text (required for record action).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    execute: async input => {
      const action = input.action as string;

      if (action === 'list') {
        const filterType = input.targetType as string | undefined;
        const results: Array<{
          targetType: string;
          targetId: string;
          entryCount: number;
          lastTimestamp?: string;
        }> = [];

        const typesToScan: TargetType[] =
          filterType && isValidTargetType(filterType)
            ? [filterType]
            : [...VALID_TARGET_TYPES];

        for (const tt of typesToScan) {
          for (const engine of insightEngines.values()) {
            const engineResults = await engine.listInsights(tt);
            results.push(...engineResults);
          }
          const defaultResults = await defaultInsightEngine.listInsights(tt);
          results.push(...defaultResults);
        }

        return JSON.stringify({ insights: results }, null, 2);
      }

      const targetType = input.targetType as string;
      const targetId = (input.targetId as string).trim().toLowerCase();

      if (action === 'record') {
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
        const result = await engine.recordInsight(
          targetType,
          targetId,
          insight
        );
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
      }

      if (action === 'recall') {
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
      }

      throw new Error(`Unknown action: ${action}`);
    },
    renderComponent: state => SelfImprovementInsightBlock({ state }),
  };
}
