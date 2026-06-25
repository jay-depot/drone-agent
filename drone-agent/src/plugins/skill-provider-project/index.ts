import path from 'node:path';
import type {
  DronePlugin,
  DroneSkillDefinition,
  DroneSkillProvider,
  DroneSkillsCapability,
} from 'drone-core';
import { PRECEDENCE_PROJECT } from 'drone-core';
import { loadSkillsFromDir } from '../skills/loader.js';

const CONFIG_DIR = '.drone-agent';
const SKILLS_DIR = 'skills';

export const skillProviderProjectPlugin: DronePlugin = {
  metadata: {
    id: 'skill-provider-project',
    name: 'Skills Provider (Project)',
    version: '0.1.0',
    description:
      'Loads skill .md files from the project .drone-agent/skills/ directory.',
    defaultEnabled: false,
    dependencies: [{ id: 'skills' }],
  },
  register: async registration => {
    const projectDir = process.cwd();
    const skillsDir = path.join(projectDir, CONFIG_DIR, SKILLS_DIR);

    let skills = new Map<string, DroneSkillDefinition>();

    const provider: DroneSkillProvider = {
      id: 'skill-provider-project',
      precedence: PRECEDENCE_PROJECT,
      getSkills: () => Array.from(skills.values()),
      getSkill: (id: string) => skills.get(id),
      reloadSkills: async () => {
        const loaded = await loadSkillsFromDir(skillsDir, 'project');
        skills = new Map(loaded.map(s => [s.id, s]));
        registration.logger.info(`reloaded ${skills.size} project skill(s)`);
      },
    };

    // Register with the skills broker
    const skillsCap = registration.request<DroneSkillsCapability>('skills');
    if (skillsCap) {
      skillsCap.registerProvider(provider);
    } else {
      registration.logger.warn(
        'skills broker not available; project skills will not be loaded'
      );
    }

    registration.hooks.onPluginsLoaded(async () => {
      await provider.reloadSkills();
      if (skills.size > 0) {
        registration.logger.info(
          `loaded ${skills.size} project skill(s): ${Array.from(skills.keys()).join(', ')}`
        );
      }
    });
  },
};
