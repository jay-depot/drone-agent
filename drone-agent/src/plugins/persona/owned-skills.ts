import path from 'node:path';
import type { DroneSkillDefinition } from 'drone-core';
import { skillStorageKey } from 'drone-core';
import { loadSkillsFromDir } from '../skills/loader.js';

const SKILLS_DIR = 'skills';

/**
 * Load every persona's owned skills from `<personaDir>/<id>/skills/`.
 *
 * Returned map is keyed by the composite storage key so that a same-named
 * skill owned by two different personas does not overwrite the other.
 */
export async function loadPersonaOwnedSkills(
  personaDir: string,
  personaIds: string[],
  options: { source: 'user' | 'project'; precedence: number }
): Promise<Map<string, DroneSkillDefinition>> {
  const result = new Map<string, DroneSkillDefinition>();
  for (const personaId of personaIds) {
    const dir = path.join(personaDir, personaId, SKILLS_DIR);
    const skills = await loadSkillsFromDir(dir, options.source);
    for (const skill of skills) {
      skill.precedence = options.precedence;
      skill.personaId = personaId;
      result.set(skillStorageKey(personaId, skill.id), skill);
    }
  }
  return result;
}
