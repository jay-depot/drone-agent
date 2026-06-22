import path from 'node:path';
import os from 'node:os';
import type {
  DronePlugin,
  DroneSkillDefinition,
  DroneSkillProvider,
} from 'drone-core';
import { PRECEDENCE_USER } from 'drone-core';
import { loadSkillsFromDir } from '../skills/loader.js';
import type { DroneSkillsCapability } from '../skills/index.js';

const CONFIG_DIR = '.drone-agent';
const SKILLS_DIR = 'skills';

export const skillProviderUserPlugin: DronePlugin = {
  metadata: {
    id: 'skill-provider-user',
    name: 'Skill Provider (User)',
    version: '0.1.0',
    description:
      'Loads skill .md files from the user ~/.drone-agent/skills/ directory.',
    defaultEnabled: false,
    dependencies: [{ id: 'skills' }],
  },
  register: async registration => {
    const skillsDir = path.join(os.homedir(), CONFIG_DIR, SKILLS_DIR);

    let skills = new Map<string, DroneSkillDefinition>();

    const provider: DroneSkillProvider = {
      id: 'skill-provider-user',
      precedence: PRECEDENCE_USER,
      getSkills: () => Array.from(skills.values()),
      getSkill: (id: string) => skills.get(id),
      reloadSkills: async () => {
        const loaded = await loadSkillsFromDir(skillsDir, 'user');
        skills = new Map(loaded.map(s => [s.id, s]));
        registration.logger.info(
          `reloaded ${skills.size} user skill(s)`
        );
      },
    };

    // Register with the skills broker
    const skillsCap = registration.request<DroneSkillsCapability>('skills');
    if (skillsCap) {
      skillsCap.registerProvider(provider);
    } else {
      registration.logger.warn(
        'skills broker not available; user skills will not be loaded'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      await provider.reloadSkills();
      if (skills.size > 0) {
        registration.logger.info(
          `loaded ${skills.size} user skill(s): ${Array.from(skills.keys()).join(', ')}`
        );
      }
    });
  },
};
