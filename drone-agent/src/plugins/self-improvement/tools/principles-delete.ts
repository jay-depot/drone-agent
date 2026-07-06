import type {
  DronePersonaCapability,
  DronePrincipleStorageEngine,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import { validateTarget } from '../validation.js';
import { resolvePrincipleEngine } from '../capability.js';

export function createPrinciplesDeleteTool(
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined,
  defaultPrincipleEngine: DronePrincipleStorageEngine
): DroneToolDefinition {
  return {
    name: 'principles-delete',
    defaultHidden: true,
    description:
      'Delete a principle by its index in the principles list for a target.',
    inputSchema: {
      type: 'object',
      properties: {
        targetType: {
          type: 'string',
          enum: ['persona', 'skill', 'project'],
          description: 'The type of target to delete a principle from.',
        },
        targetId: {
          type: 'string',
          description: 'The id of the persona, skill, or project category.',
        },
        index: {
          type: 'integer',
          description: 'The 0-based index of the principle to delete.',
        },
      },
      required: ['targetType', 'targetId', 'index'],
      additionalProperties: false,
    },
    execute: async input => {
      const targetType = input.targetType as string;
      const targetId = (input.targetId as string).trim().toLowerCase();
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
      const result = await engine.deletePrinciple(targetType, targetId, index);

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
    },
  };
}
