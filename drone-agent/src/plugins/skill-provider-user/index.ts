import path from 'node:path';
import os from 'node:os';
import type {
  DronePlugin,
  DroneSkillDefinition,
  DroneSkillProvider,
  DroneSkillWriter,
  DroneSkillsCapability,
} from 'drone-core';
import { PRECEDENCE_USER } from 'drone-core';
import { loadSkillsFromDir } from '../skills/loader.js';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

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
        registration.logger.info(`reloaded ${skills.size} user skill(s)`);
      },
    };

    // ── Skill writer ─────────────────────────────────────────────────
    const writer: DroneSkillWriter = {
      id: 'skill-provider-user',
      scope: 'user',
      label: 'User (~/.drone-agent/skills/)',
      exists: async (id: string) => {
        const filePath = path.join(skillsDir, `${id}.md`);
        try {
          await access(filePath, fsConstants.F_OK);
          return true;
        } catch {
          return false;
        }
      },
      writeSkill: async (id: string, content: string) => {
        const filePath = path.join(skillsDir, `${id}.md`);
        await mkdir(skillsDir, { recursive: true });
        await writeFile(filePath, content, 'utf-8');
        return { filePath };
      },
    };

    // Register with the skills broker
    const skillsCap = registration.request<DroneSkillsCapability>('skills');
    if (skillsCap) {
      skillsCap.registerProvider(provider);
      skillsCap.registerWriter(writer);
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
