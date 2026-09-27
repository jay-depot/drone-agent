import type { DroneSkillDefinition } from 'drone-core';

/**
 * Find a skill in a map keyed by storage key, matching on the flat public id.
 *
 * Persona-owned skills are keyed by `<personaId>/<skillId>` so that two
 * personas may own same-named skills; global skills keep `key === id` and are
 * found by a direct lookup.
 */
export function findSkillByPublicId(
  map: Map<string, DroneSkillDefinition>,
  id: string
): DroneSkillDefinition | undefined {
  const direct = map.get(id);
  if (direct && direct.id === id) return direct;
  for (const skill of map.values()) {
    if (skill.id === id) return skill;
  }
  return undefined;
}
