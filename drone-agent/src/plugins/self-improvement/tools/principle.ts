import type {
  DronePersonaCapability,
  DronePrincipleStorageEngine,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import {
  VALID_TARGET_TYPES,
  isValidTargetType,
  validateTarget,
  type TargetType,
} from '../validation.js';
import { resolvePrincipleEngine } from '../capability.js';
import { principleEngines } from '../state.js';

export function createPrincipleTool(
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined,
  defaultPrincipleEngine: DronePrincipleStorageEngine
): DroneToolDefinition {
  return {
    name: 'principle',
    description:
      'Manage self-improvement principles. ' +
      'Use action="store" to create, action="list" to browse files, ' +
      'action="recall" to read entries, action="delete" to remove by index.',
    defaultHidden: true,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['store', 'list', 'recall', 'delete'],
          description: 'What to do.',
        },
        targetType: {
          type: 'string',
          enum: ['persona', 'skill', 'project'],
          description: 'Target type (required for store, recall, and delete).',
        },
        targetId: {
          type: 'string',
          description: 'Target id (required for store, recall, and delete).',
        },
        principle: {
          type: 'string',
          description: 'Principle text (required for store).',
        },
        source: {
          type: 'string',
          description: 'Optional source description (store action).',
        },
        index: {
          type: 'integer',
          description: '0-based index to delete (required for delete action).',
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
          const defaultResults =
            await defaultPrincipleEngine.listPrinciples(tt);
          results.push(...defaultResults);
        }

        return JSON.stringify({ principles: results }, null, 2);
      }

      const targetType = input.targetType as string;
      const targetId = (input.targetId as string).trim().toLowerCase();

      if (action === 'store') {
        const principle = (input.principle as string).trim();
        const source =
          (input.source as string | undefined)?.trim() || undefined;

        if (!principle) {
          throw new Error('principle must be a non-empty string.');
        }

        validateTarget(targetType, targetId, personaCap(), skillsCap());

        const engine = resolvePrincipleEngine(
          targetType,
          targetId,
          defaultPrincipleEngine,
          personaCap(),
          skillsCap()
        );
        const result = await engine.storePrinciple(
          targetType,
          targetId,
          principle,
          source
        );

        return JSON.stringify(
          {
            ok: true,
            targetType,
            targetId,
            principleCount: result.principleCount,
            message: `Principle stored for ${targetType} "${targetId}" via ${engine.providerId}.`,
          },
          null,
          2
        );
      }

      if (action === 'recall') {
        validateTarget(targetType, targetId, personaCap(), skillsCap());

        const engine = resolvePrincipleEngine(
          targetType,
          targetId,
          defaultPrincipleEngine,
          personaCap(),
          skillsCap()
        );
        const principles = await engine.readPrinciples(targetType, targetId);
        return JSON.stringify({ targetType, targetId, principles }, null, 2);
      }

      if (action === 'delete') {
        const index = input.index as number;

        if (
          typeof index !== 'number' ||
          !Number.isInteger(index) ||
          index < 0
        ) {
          throw new Error('index must be a non-negative integer.');
        }

        validateTarget(targetType, targetId, personaCap(), skillsCap());

        const engine = resolvePrincipleEngine(
          targetType,
          targetId,
          defaultPrincipleEngine,
          personaCap(),
          skillsCap()
        );
        const result = await engine.deletePrinciple(
          targetType,
          targetId,
          index
        );

        return JSON.stringify(
          {
            ok: true,
            targetType,
            targetId,
            remainingCount: result.remainingCount,
            message: `Principle deleted from ${targetType} "${targetId}" via ${engine.providerId}.`,
          },
          null,
          2
        );
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
