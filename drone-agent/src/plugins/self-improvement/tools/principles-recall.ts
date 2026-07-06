import type {
  DronePersonaCapability,
  DronePrincipleStorageEngine,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import { validateTarget } from '../validation.js';
import { resolvePrincipleEngine } from '../capability.js';

export function createPrinciplesRecallTool(
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined,
  defaultPrincipleEngine: DronePrincipleStorageEngine
): DroneToolDefinition {
  return {
    name: 'principles-recall',
    description:
      'Read all principles for a specific target (persona, skill, or project).',
    inputSchema: {
      type: 'object',
      properties: {
        targetType: {
          type: 'string',
          enum: ['persona', 'skill', 'project'],
          description: 'The type of target to read principles for.',
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

      const engine = resolvePrincipleEngine(
        targetType,
        targetId,
        defaultPrincipleEngine,
        personaCap(),
        skillsCap()
      );
      const principles = await engine.readPrinciples(targetType, targetId);
      return JSON.stringify({ targetType, targetId, principles }, null, 2);
    },
  };
}
