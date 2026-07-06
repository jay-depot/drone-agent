import path from 'node:path';
import type { DroneSkillsCapability } from 'drone-core';
import { CONFIG_DIR, INSIGHTS_SUBDIR, PRINCIPLES_SUBDIR } from './constants.js';

/**
 * Resolve the directory and file path for an insights file.
 */
export function resolveInsightPaths(
  targetType: string,
  targetId: string,
  baseDir: string,
  skillsCap?: DroneSkillsCapability
): { insightsDir: string; filePath: string } {
  if (targetType === 'persona') {
    const personaDir = path.join(baseDir, CONFIG_DIR, 'personas', targetId);
    return {
      insightsDir: path.join(personaDir, INSIGHTS_SUBDIR),
      filePath: path.join(personaDir, INSIGHTS_SUBDIR, 'insights.json'),
    };
  }

  if (targetType === 'skill') {
    const skill = skillsCap?.getSkill(targetId);
    if (skill?.personaId) {
      const personaDir = path.join(
        baseDir,
        CONFIG_DIR,
        'personas',
        skill.personaId
      );
      return {
        insightsDir: path.join(personaDir, INSIGHTS_SUBDIR),
        filePath: path.join(personaDir, INSIGHTS_SUBDIR, `${targetId}.json`),
      };
    }
  }

  return {
    insightsDir: path.join(baseDir, CONFIG_DIR, INSIGHTS_SUBDIR, targetType),
    filePath: path.join(
      baseDir,
      CONFIG_DIR,
      INSIGHTS_SUBDIR,
      targetType,
      `${targetId}.json`
    ),
  };
}

/**
 * Resolve the directory and file path for a principles file.
 */
export function resolvePrinciplePaths(
  targetType: string,
  targetId: string,
  baseDir: string,
  skillsCap?: DroneSkillsCapability
): { principlesDir: string; filePath: string } {
  if (targetType === 'persona') {
    const personaDir = path.join(baseDir, CONFIG_DIR, 'personas', targetId);
    return {
      principlesDir: path.join(personaDir, PRINCIPLES_SUBDIR),
      filePath: path.join(personaDir, PRINCIPLES_SUBDIR, 'principles.json'),
    };
  }

  if (targetType === 'skill') {
    const skill = skillsCap?.getSkill(targetId);
    if (skill?.personaId) {
      const personaDir = path.join(
        baseDir,
        CONFIG_DIR,
        'personas',
        skill.personaId
      );
      return {
        principlesDir: path.join(personaDir, PRINCIPLES_SUBDIR),
        filePath: path.join(personaDir, PRINCIPLES_SUBDIR, `${targetId}.json`),
      };
    }
  }

  return {
    principlesDir: path.join(
      baseDir,
      CONFIG_DIR,
      PRINCIPLES_SUBDIR,
      targetType
    ),
    filePath: path.join(
      baseDir,
      CONFIG_DIR,
      PRINCIPLES_SUBDIR,
      targetType,
      `${targetId}.json`
    ),
  };
}
