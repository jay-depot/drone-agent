/**
 * Migration Service — local filesystem path helpers.
 */

import path from 'node:path';
import { getLocalBaseDir } from './helpers.js';

const CONFIG_DIR = '.drone-agent';
const PERSONA_DIR = 'personas';
const SKILLS_DIR = 'skills';
const INSIGHTS_DIR = 'insights';
const PRINCIPLES_DIR = 'principles';

export function getPersonaDir(scope: 'project' | 'user'): string {
  return path.join(getLocalBaseDir(scope), CONFIG_DIR, PERSONA_DIR);
}

export function getPersonaFilePath(
  scope: 'project' | 'user',
  id: string
): string {
  return path.join(getPersonaDir(scope), id, 'persona.md');
}

export function getSkillsDir(scope: 'project' | 'user'): string {
  return path.join(getLocalBaseDir(scope), CONFIG_DIR, SKILLS_DIR);
}

export function getSkillFilePath(
  scope: 'project' | 'user',
  id: string
): string {
  return path.join(getSkillsDir(scope), `${id}.md`);
}

/** Directory holding a persona's owned skills: `personas/<id>/skills/`. */
export function getPersonaSkillsDir(
  scope: 'project' | 'user',
  personaId: string
): string {
  return path.join(getPersonaDir(scope), personaId, SKILLS_DIR);
}

/** File path for a persona-owned skill: `personas/<id>/skills/<skill>.md`. */
export function getPersonaSkillFilePath(
  scope: 'project' | 'user',
  personaId: string,
  id: string
): string {
  return path.join(getPersonaSkillsDir(scope, personaId), `${id}.md`);
}

export function getInsightsDir(scope: 'project' | 'user'): string {
  return path.join(getLocalBaseDir(scope), CONFIG_DIR, INSIGHTS_DIR);
}

export function getPrinciplesDir(scope: 'project' | 'user'): string {
  return path.join(getLocalBaseDir(scope), CONFIG_DIR, PRINCIPLES_DIR);
}
