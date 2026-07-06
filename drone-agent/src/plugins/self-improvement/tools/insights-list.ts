import type {
  DroneInsightStorageEngine,
  DroneToolDefinition,
} from 'drone-core';
import { VALID_TARGET_TYPES, isValidTargetType, type TargetType } from '../validation.js';
import { insightEngines } from '../state.js';

export function createInsightsListTool(
  defaultInsightEngine: DroneInsightStorageEngine
): DroneToolDefinition {
  return {
    name: 'insights-list',
    defaultHidden: true,
    description:
      'List all insight files with their entry counts and last timestamps. ' +
      'Optionally filter by targetType (persona, skill, or project).',
    inputSchema: {
      type: 'object',
      properties: {
        targetType: {
          type: 'string',
          enum: ['persona', 'skill', 'project'],
          description:
            'Optional filter: only list insights for this target type.',
        },
      },
      additionalProperties: false,
    },
    execute: async input => {
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
    },
  };
}
