import type {
  DronePrincipleStorageEngine,
  DroneToolDefinition,
} from 'drone-core';
import {
  VALID_TARGET_TYPES,
  isValidTargetType,
  type TargetType,
} from '../validation.js';
import { principleEngines } from '../state.js';

export function createPrinciplesListTool(
  defaultPrincipleEngine: DronePrincipleStorageEngine
): DroneToolDefinition {
  return {
    name: 'principles-list',
    description:
      'List all principle files with their entry counts. ' +
      'Optionally filter by targetType (persona, skill, or project).',
    inputSchema: {
      type: 'object',
      properties: {
        targetType: {
          type: 'string',
          enum: ['persona', 'skill', 'project'],
          description:
            'Optional filter: only list principles for this target type.',
        },
      },
      additionalProperties: false,
    },
    execute: async input => {
      const filterType = input.targetType as string | undefined;
      const results: Array<{
        targetType: string;
        targetId: string;
        principleCount: number;
      }> = [];

      const typesToScan: TargetType[] =
        filterType && isValidTargetType(filterType)
          ? [filterType]
          : [...VALID_TARGET_TYPES];

      for (const tt of typesToScan) {
        for (const engine of principleEngines.values()) {
          const engineResults = await engine.listPrinciples(tt);
          results.push(...engineResults);
        }
        const defaultResults = await defaultPrincipleEngine.listPrinciples(tt);
        results.push(...defaultResults);
      }

      return JSON.stringify({ principles: results }, null, 2);
    },
  };
}
