import type {
  DroneInsightStorageEngine,
  DronePersonaCapability,
  DronePrincipleStorageEngine,
  DroneSelfImprovementCapability,
  DroneSkillsCapability,
} from 'drone-core';
import { resolveTargetScope } from './validation.js';
import { insightEngines, principleEngines } from './state.js';

/**
 * Resolve the appropriate storage engine for a target.
 * For swarm-scoped targets (beacon/coordinator), looks up the
 * registered engine by provider ID. For local-scoped targets
 * (project/user), returns the default file-based engine.
 */
export function resolveInsightEngine(
  targetType: string,
  targetId: string,
  defaultInsightEngine: DroneInsightStorageEngine,
  personaCap?: DronePersonaCapability,
  skillsCap?: DroneSkillsCapability
): DroneInsightStorageEngine {
  const scope = resolveTargetScope(targetType, targetId, personaCap, skillsCap);
  if (scope === 'beacon' || scope === 'coordinator') {
    for (const engine of insightEngines.values()) {
      return engine;
    }
  }
  return defaultInsightEngine;
}

export function resolvePrincipleEngine(
  targetType: string,
  targetId: string,
  defaultPrincipleEngine: DronePrincipleStorageEngine,
  personaCap?: DronePersonaCapability,
  skillsCap?: DroneSkillsCapability
): DronePrincipleStorageEngine {
  const scope = resolveTargetScope(targetType, targetId, personaCap, skillsCap);
  if (scope === 'beacon' || scope === 'coordinator') {
    for (const engine of principleEngines.values()) {
      return engine;
    }
  }
  return defaultPrincipleEngine;
}

/**
 * Create the DroneSelfImprovementCapability object.
 */
export function createSelfImprovementCapability(
  logger: { info: (msg: string) => void },
  defaultInsightEngine: DroneInsightStorageEngine,
  defaultPrincipleEngine: DronePrincipleStorageEngine,
  personaCap: () => DronePersonaCapability | undefined,
  skillsCap: () => DroneSkillsCapability | undefined
): DroneSelfImprovementCapability {
  return {
    registerInsightEngine: (engine: DroneInsightStorageEngine) => {
      insightEngines.set(engine.providerId, engine);
      logger.info(`Registered insight engine: ${engine.providerId}`);
    },
    unregisterInsightEngine: (providerId: string) => {
      insightEngines.delete(providerId);
      logger.info(`Unregistered insight engine: ${providerId}`);
    },
    registerPrincipleEngine: (engine: DronePrincipleStorageEngine) => {
      principleEngines.set(engine.providerId, engine);
      logger.info(`Registered principle engine: ${engine.providerId}`);
    },
    unregisterPrincipleEngine: (providerId: string) => {
      principleEngines.delete(providerId);
      logger.info(`Unregistered principle engine: ${providerId}`);
    },
    getPrinciples: async (targetType: string, targetId: string) => {
      const engine = resolvePrincipleEngine(
        targetType,
        targetId,
        defaultPrincipleEngine,
        personaCap(),
        skillsCap()
      );
      return engine.readPrinciples(targetType, targetId);
    },
  };
}
