import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DroneSkillDefinition } from 'drone-core';

const SKILLS_DIR = 'skills';
const CONFIG_DIR = '.drone-agent';

/**
 * Parse a skill .md file with YAML frontmatter.
 *
 * Expected format:
 *   ---
 *   name: webapp-testing
 *   description: 'Test web applications using Playwright.'
 *   recall:
 *     - The user mentions testing, debugging, or verifying a web application
 *     - The project contains Playwright or browser test configuration
 *   model-invocation: true
 *   ---
 *   # Web Application Testing
 *   ...
 */
function parseSkillMd(
  id: string,
  content: string,
  source: 'user' | 'project'
): DroneSkillDefinition {
  const definition: DroneSkillDefinition = {
    id,
    name: id,
    description: `Skill: ${id}`,
    recall: [],
    modelInvocation: true,
    body: content.trim(),
    source,
  };

  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    return definition;
  }

  const rawFrontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2].trim();

  definition.body = body || definition.body;

  // Parse YAML-like frontmatter
  const lines = rawFrontmatter.split('\n');
  let currentArrayKey: string | null = null;
  const arrayValues: string[] = [];

  for (const line of lines) {
    const arrayItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (arrayItemMatch && currentArrayKey) {
      arrayValues.push(arrayItemMatch[1]);
      continue;
    }

    // Flush any collected array
    if (currentArrayKey) {
      if (currentArrayKey === 'recall') {
        definition.recall = [...arrayValues];
      }
      currentArrayKey = null;
      arrayValues.length = 0;
    }

    const kvMatch = line.match(/^(\w+(?:-\w+)*):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();
    // Strip surrounding single or double quotes
    const value = rawValue.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');

    if (key === 'name') {
      definition.name = value;
    } else if (key === 'description') {
      definition.description = value;
    } else if (key === 'recall') {
      if (value === '') {
        currentArrayKey = 'recall';
      }
    } else if (key === 'model-invocation') {
      definition.modelInvocation = value === 'true';
    }
  }

  // Flush trailing array
  if (currentArrayKey === 'recall' && arrayValues.length > 0) {
    definition.recall = [...arrayValues];
  }

  return definition;
}

/**
 * Load all skill .md files from a given directory.
 */
export async function loadSkillsFromDir(
  dir: string,
  source: 'user' | 'project'
): Promise<DroneSkillDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const skills: DroneSkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const id = entry.slice(0, -3);
    const content = await readFile(path.join(dir, entry), 'utf-8');
    skills.push(parseSkillMd(id, content, source));
  }
  return skills;
}

/**
 * Load all skills from user and project directories.
 * Project-level skills override user-level skills with the same id.
 */
export async function loadSkills(
  projectDir: string
): Promise<Map<string, DroneSkillDefinition>> {
  const userDir = path.join(os.homedir(), CONFIG_DIR, SKILLS_DIR);
  const projectSkillsDir = path.join(projectDir, CONFIG_DIR, SKILLS_DIR);

  const userSkills = await loadSkillsFromDir(userDir, 'user');
  const projectSkills = await loadSkillsFromDir(projectSkillsDir, 'project');

  const map = new Map<string, DroneSkillDefinition>();
  for (const s of userSkills) {
    map.set(s.id, s);
  }
  // Project overrides
  for (const s of projectSkills) {
    map.set(s.id, s);
  }

  return map;
}
