import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DronePersonaDefinition } from 'drone-core';

const PERSONA_DIR = 'personas';
const CONFIG_DIR = '.drone-agent';

/**
 * Parse a persona .md file with YAML frontmatter.
 *
 * Expected format:
 *   ---
 *   name: Coder
 *   description: Focused on implementation
 *   color: cyan           # optional UI tint applied when active
 *   fragments:
 *     - Prefer TypeScript
 *   ---
 *   System prompt override body (optional)
 */
function parsePersonaMd(id: string, content: string): DronePersonaDefinition {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    // No frontmatter — use the whole file as the system prompt override
    return {
      id,
      name: id,
      description: `Persona: ${id}`,
      systemPromptOverride: content.trim() || undefined,
    };
  }

  const rawFrontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2].trim();

  const definition: DronePersonaDefinition = {
    id,
    name: id,
    description: `Persona: ${id}`,
  };

  // Parse YAML-like frontmatter (simple line-by-line, no nested objects beyond arrays)
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
      if (currentArrayKey === 'fragments') {
        definition.promptFragments = [...arrayValues];
      }
      currentArrayKey = null;
      arrayValues.length = 0;
    }

    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();
    // Strip surrounding single or double quotes
    const value = rawValue.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');

    if (key === 'name') {
      definition.name = value;
    } else if (key === 'description') {
      definition.description = value;
    } else if (key === 'color' || key === 'uiColor' || key === 'tint') {
      // Frontmatter-friendly aliases. `color` reads most naturally in a
      // .md file; `uiColor` mirrors the type field; `tint` matches the
      // vocabulary used in tui/theme.ts.
      definition.uiColor = value;
    } else if (key === 'fragments') {
      if (value === '') {
        currentArrayKey = 'fragments';
      }
    }
  }

  // Flush trailing array
  if (currentArrayKey === 'fragments' && arrayValues.length > 0) {
    definition.promptFragments = [...arrayValues];
  }

  if (body.length > 0) {
    definition.systemPromptOverride = body;
  }

  return definition;
}

/**
 * Load all persona .md files from a given directory.
 */
async function loadPersonasFromDir(
  dir: string
): Promise<DronePersonaDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const personas: DronePersonaDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const id = entry.slice(0, -3); // strip .md
    const content = await readFile(path.join(dir, entry), 'utf-8');
    personas.push(parsePersonaMd(id, content));
  }
  return personas;
}

/**
 * Load all personas from user and project directories.
 * Project-level personas override user-level personas with the same id.
 */
export async function loadPersonas(
  projectDir: string
): Promise<Map<string, DronePersonaDefinition>> {
  const userDir = path.join(os.homedir(), CONFIG_DIR, PERSONA_DIR);
  const projectPersonaDir = path.join(projectDir, CONFIG_DIR, PERSONA_DIR);

  const userPersonas = await loadPersonasFromDir(userDir);
  const projectPersonas = await loadPersonasFromDir(projectPersonaDir);

  const map = new Map<string, DronePersonaDefinition>();
  for (const p of userPersonas) {
    map.set(p.id, p);
  }
  // Project overrides
  for (const p of projectPersonas) {
    map.set(p.id, p);
  }

  return map;
}
