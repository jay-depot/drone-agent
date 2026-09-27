import path from 'node:path';
import os from 'node:os';
import type {
  DronePersonaCapability,
  DronePersonaDefinition,
  DronePersonaProvider,
  DronePersonaWriter,
  DronePlugin,
  DroneSkillDefinition,
  DroneSkillProvider,
  DroneSkillsCapability,
} from 'drone-core';
import { PRECEDENCE_PERSONA_USER, PRECEDENCE_USER } from 'drone-core';
import { loadPersonasFromDir } from '../persona/loader.js';
import { loadPersonaOwnedSkills } from '../persona/owned-skills.js';
import { findSkillByPublicId } from '../skills/keying.js';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const CONFIG_DIR = '.drone-agent';
const PERSONA_DIR = 'personas';

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
    dependencies: [{ id: 'persona' }, { id: 'skills', optional: true }],
  },
  register: async registration => {
    const personaDir = path.join(os.homedir(), CONFIG_DIR, PERSONA_DIR);

    let personas = new Map<string, DronePersonaDefinition>();
    // Aggregated map of persona-owned skills, keyed by composite storage key
    // (`<personaId>/<skillId>`) so two personas may own same-named skills.
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
        registration.logger.info(`reloaded ${personas.size} user persona(s)`);

        const skillsCap = registration.request<DroneSkillsCapability>('skills');
        if (skillsCap) {
          skillsCap.unregisterProvider(PERSONA_SKILLS_PROVIDER_ID);

          personaSkills = await loadPersonaOwnedSkills(
            personaDir,
            loaded.map(p => p.id),
            { source: 'user', precedence: PRECEDENCE_PERSONA_USER }
          );

          if (personaSkills.size > 0) {
            const personaSkillProvider: DroneSkillProvider = {
              id: PERSONA_SKILLS_PROVIDER_ID,
              precedence: PRECEDENCE_PERSONA_USER,
              getSkills: () => Array.from(personaSkills.values()),
              getSkill: (id: string) => findSkillByPublicId(personaSkills, id),
              reloadSkills: async () => {
                // Skills are reloaded as part of persona reload
              },
            };
            skillsCap.registerProvider(personaSkillProvider);
          }
        }
      },
    };

    // ── Persona writer ───────────────────────────────────────────────
    const writer: DronePersonaWriter = {
      id: 'persona-provider-user',
      scope: 'user',
      label: 'User (~/.drone-agent/personas/<name>/persona.md)',
      exists: async (id: string) => {
        const filePath = path.join(personaDir, id, 'persona.md');
        try {
          await access(filePath, fsConstants.F_OK);
          return true;
        } catch {
          return false;
        }
      },
      writePersona: async (id: string, content: string) => {
        const targetDir = path.join(personaDir, id);
        const filePath = path.join(targetDir, 'persona.md');
        await mkdir(targetDir, { recursive: true });
        await writeFile(filePath, content, 'utf-8');
        return { filePath };
      },
    };

    // Register with the persona broker
    const personaCap = registration.request<DronePersonaCapability>('persona');
    if (personaCap) {
      personaCap.registerProvider(provider);
      personaCap.registerWriter(writer);
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
