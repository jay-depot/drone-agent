import type {
  DronePersonaCapability,
  DronePrincipleStorageEngine,
  DroneSkillsCapability,
  DroneToolDefinition,
} from 'drone-core';
import { validateTarget } from '../validation.js';
import { resolvePrincipleEngine } from '../capability.js';

export function createPrinciplesStoreTool(
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined,
  defaultPrincipleEngine: DronePrincipleStorageEngine
): DroneToolDefinition {
  return {
    name: 'principles-store',
    defaultHidden: true,
    description:
      'Store a principle for a persona, skill, or project. ' +
      'Principles are derived from patterns found in insights and are ' +
      'automatically injected into persona prompt fragments and skill recall results.',
    inputSchema: {
      type: 'object',
      properties: {
        targetType: {
          type: 'string',
          enum: ['persona', 'skill', 'project'],
          description:
            'Whether this principle applies to a persona, a skill, or the project.',
        },
        targetId: {
          type: 'string',
          description:
            'The id of the persona or skill this principle applies to. ' +
            'For project principles, use a descriptive category like "architecture" or "workflow".',
        },
        principle: {
          type: 'string',
          description:
            'The principle text. Should be a concise, actionable statement.',
        },
        source: {
          type: 'string',
          description:
            'Optional description of where this principle came from (e.g. "Derived from 3 insights about code style").',
        },
      },
      required: ['targetType', 'targetId', 'principle'],
      additionalProperties: false,
    },
    execute: async input => {
      const targetType = input.targetType as string;
      const targetId = (input.targetId as string).trim().toLowerCase();
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
    },
  };
}
