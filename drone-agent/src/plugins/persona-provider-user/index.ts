import path from 'node:path';
import os from 'node:os';
import type {
  DronePersonaDefinition,
  DronePersonaProvider,
  DronePlugin,
  DroneSkillDefinition,
  DroneSkillProvider,
} from 'drone-core';
import { PRECEDENCE_PERSONA_USER, PRECEDENCE_USER } from 'drone-core';
import { loadPersonasFromDir } from '../persona/loader.js';
import { loadSkillsFromDir } from '../skills/loader.js';
import type { DronePersonaCapability } from '../persona/index.js';
import type { DroneSkillsCapability } from '../skills/index.js';

const CONFIG_DIR = '.drone-agent';
const PERSONA_DIR = 'personas';
const SKILLS_DIR = 'skills';

/**
 * Provider id for persona-owned user skills.
 * Used to register/unregister with the skills broker.
 */
const PERSONA_SKILLS_PROVIDER_ID = 'persona-owned-skills-user';

export const personaProviderUserPlugin: DronePlugin = {
  metadata: {
    id: 'persona-provider-user',
    name: 'Persona Provider (User)',
    version: '0.1.0',
    description:
      'Loads persona .md files from the user ~/.drone-agent/personas/ directory.',
    defaultEnabled: false,
    dependencies: [
      { id: 'persona' },
      { id: 'skills', optional: true },
    ],
  },
  register: async registration => {
    const personaDir = path.join(os.homedir(), CONFIG_DIR, PERSONA_DIR);

    let personas = new Map<string, DronePersonaDefinition>();
    // Aggregated map of persona-owned skills (id -> skill)
    let personaSkills = new Map<string, DroneSkillDefinition>();

    // ── Persona provider ─────────────────────────────────────────────
    const provider: DronePersonaProvider = {
      id: 'persona-provider-user',
      precedence: PRECEDENCE_USER,
      getPersonas: () => Array.from(personas.values()),
      getPersona: (id: string) => personas.get(id),
      reloadPersonas: async () => {
        const loaded = await loadPersonasFromDir(personaDir, 'user');
        personas = new Map(loaded.map(p => [p.id, p]));
        registration.logger.info(
          `reloaded ${personas.size} user persona(s)`
        );

        // ── Reload persona-owned skills ────────────────────────────
        const skillsCap = registration.request<DroneSkillsCapability>('skills');
        if (skillsCap) {
          // Unregister previous persona-owned skills provider
          skillsCap.unregisterProvider(PERSONA_SKILLS_PROVIDER_ID);

          // Build new aggregated map of persona-owned skills.
          // Each persona's skills live in <personaDir>/<id>/skills/.
          const newSkills = new Map<string, DroneSkillDefinition>();

          for (const persona of loaded) {
            if (!persona.skillIds || persona.skillIds.length === 0) continue;
            const personaSkillsDir = path.join(personaDir, persona.id, SKILLS_DIR);
            const allSkills = await loadSkillsFromDir(personaSkillsDir, 'user');

            for (const skillId of persona.skillIds) {
              const skill = allSkills.find(s => s.id === skillId);
              if (skill) {
                skill.precedence = PRECEDENCE_PERSONA_USER;
                newSkills.set(skill.id, skill);
              }
            }
          }

          personaSkills = newSkills;

          if (personaSkills.size > 0) {
            const personaSkillProvider: DroneSkillProvider = {
              id: PERSONA_SKILLS_PROVIDER_ID,
              precedence: PRECEDENCE_PERSONA_USER,
              getSkills: () => Array.from(personaSkills.values()),
              getSkill: (id: string) => personaSkills.get(id),
              reloadSkills: async () => {
                // Skills are reloaded as part of persona reload
              },
            };
            skillsCap.registerProvider(personaSkillProvider);
          }
        }
      },
    };

    // Register with the persona broker
    const personaCap = registration.request<DronePersonaCapability>('persona');
    if (personaCap) {
      personaCap.registerProvider(provider);
    } else {
      registration.logger.warn(
        'persona broker not available; user personas will not be loaded'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      await provider.reloadPersonas();
      if (personas.size > 0) {
        registration.logger.info(
          `loaded ${personas.size} user persona(s): ${Array.from(personas.keys()).join(', ')}`
        );
      }
    });
  },
};
