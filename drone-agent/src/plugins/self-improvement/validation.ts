import os from 'node:os';
import type { DronePersonaCapability, DroneSkillsCapability } from 'drone-core';

export const VALID_TARGET_TYPES = ['persona', 'skill', 'project'] as const;
export type TargetType = (typeof VALID_TARGET_TYPES)[number];

export function isValidTargetType(t: string): t is TargetType {
  return VALID_TARGET_TYPES.includes(t as TargetType);
}

/**
 * Trim a possibly-missing string input. Returns '' for non-strings so
 * downstream non-empty guards produce friendly errors instead of TypeErrors.
 */
export function trimOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate a target type and id. Throws on invalid input.
 */
export function validateTarget(
  targetType: string,
  targetId: string,
  personaCap?: DronePersonaCapability,
  skillsCap?: DroneSkillsCapability
): void {
  if (!isValidTargetType(targetType)) {
    throw new Error(
      `Invalid targetType "${targetType}". Must be "persona", "skill", or "project".`
    );
  }
  if (!targetId) {
    throw new Error('targetId must be a non-empty string.');
  }

  if (targetType === 'persona') {
    if (personaCap) {
      const persona = personaCap.getPersonas().find(p => p.id === targetId);
      if (!persona) {
        throw new Error(
          `Unknown persona "${targetId}". Available: ${personaCap
            .getPersonas()
            .map(p => p.id)
            .join(', ')}`
        );
      }
    }
  } else if (targetType === 'skill') {
    if (skillsCap) {
      const skill = skillsCap.getSkill(targetId);
      if (!skill) {
        throw new Error(
          `Unknown skill "${targetId}". Available: ${skillsCap
            .getSkills()
            .map(s => s.id)
            .join(', ')}`
        );
      }
    }
  }
  // project — always valid
}

/**
 * Determine the scope of a target (project, user, beacon, coordinator).
 * Returns undefined for project targets (always local).
 */
export function resolveTargetScope(
  targetType: string,
  targetId: string,
  personaCap?: DronePersonaCapability,
  skillsCap?: DroneSkillsCapability
): string | undefined {
  if (targetType === 'persona') {
    if (personaCap) {
      const persona = personaCap.getPersonas().find(p => p.id === targetId);
      return persona?.scope;
    }
  } else if (targetType === 'skill') {
    if (skillsCap) {
      const skill = skillsCap.getSkill(targetId);
      return skill?.source;
    }
  }
  return undefined;
}

/**
 * Determine the base directory for a target, considering scope.
 */
export function resolveBaseDir(
  targetType: string,
  targetId: string,
  projectDir: string,
  personaCap?: DronePersonaCapability,
  skillsCap?: DroneSkillsCapability
): string {
  if (targetType === 'persona') {
    if (personaCap) {
      const persona = personaCap.getPersonas().find(p => p.id === targetId);
      if (persona?.scope === 'user') {
        return os.homedir();
      }
    }
  } else if (targetType === 'skill') {
    if (skillsCap) {
      const skill = skillsCap.getSkill(targetId);
      if (skill?.source === 'user') {
        return os.homedir();
      }
    }
  }
  return projectDir;
}
