import {
  readdir,
  readFile,
  access,
  constants as fsConstants,
} from 'node:fs/promises';
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
 *   skills:
 *     - code-review
 *   tools:
 *     - exec.*
 *     - file.*
 *     - !exec.run
 *   ---
 *   System prompt override body (optional)
 *
 * The `skills` field filters which global skills the LLM sees (glob patterns).
 * The `tools` field filters which tools the LLM sees (glob patterns).
 * Persona-owned skills (from the `skills/` subdirectory) are always visible.
 */
function _parsePersonaMdInternal(
  id: string,
  content: string,
  scope?: 'user' | 'project'
): DronePersonaDefinition {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    // No frontmatter — use the whole file as the system prompt override
    return {
      id,
      name: id,
      description: `Persona: ${id}`,
      systemPromptOverride: content.trim() || undefined,
      scope,
    };
  }

  const rawFrontmatter = frontmatterMatch[1];
  const body = frontmatterMatch[2].trim();

  const definition: DronePersonaDefinition = {
    id,
    name: id,
    description: `Persona: ${id}`,
    scope,
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
      } else if (currentArrayKey === 'skills') {
        definition.allowedSkills = [...arrayValues];
      } else if (currentArrayKey === 'tools') {
        definition.allowedTools = [...arrayValues];
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
    } else if (key === 'skills') {
      if (value === '') {
        currentArrayKey = 'skills';
      }
    } else if (key === 'tools') {
      if (value === '') {
        currentArrayKey = 'tools';
      }
    } else if (key === 'toolCallLimit') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
        definition.toolCallLimit = parsed;
      }
      // Silently ignore invalid values (the user can fix the file)
    }
  }

  // Flush trailing array
  if (currentArrayKey === 'fragments' && arrayValues.length > 0) {
    definition.promptFragments = [...arrayValues];
  }
  if (currentArrayKey === 'skills' && arrayValues.length > 0) {
    definition.allowedSkills = [...arrayValues];
  }
  if (currentArrayKey === 'tools' && arrayValues.length > 0) {
    definition.allowedTools = [...arrayValues];
  }

  if (body.length > 0) {
    definition.systemPromptOverride = body;
  }

  return definition;
}

/**
 * Load all persona .md files from a given directory.
 *
 * Each persona lives in a subdirectory named after its id, with the
 * persona definition in a `persona.md` file inside that subdirectory.
 * Subdirectories without a `persona.md` file are silently skipped.
 */
export async function loadPersonasFromDir(
  dir: string,
  scope: 'user' | 'project'
): Promise<DronePersonaDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const personas: DronePersonaDefinition[] = [];
  for (const entry of entries) {
    const personaDir = path.join(dir, entry);
    const personaFile = path.join(personaDir, 'persona.md');
    try {
      await access(personaFile, fsConstants.F_OK);
    } catch {
      // Not a persona subdirectory — skip
      continue;
    }
    const id = entry; // subdirectory name is the persona id
    const content = await readFile(personaFile, 'utf-8');
    personas.push(_parsePersonaMdInternal(id, content, scope));
  }
  return personas;
}

/**
 * Exported alias for `parsePersonaMd`. Used by the persona creation
 * wizard to validate the LLM's output before writing it to disk.
 * The function does not throw on missing frontmatter — it falls back
 * to a plain system-prompt-only persona. The wizard treats the
 * presence of frontmatter + a matching id as the validation signal.
 *
 * Note: The exported version does not accept a scope parameter since
 * the wizard validates before the file is written to a specific location.
 * The scope is assigned by `loadPersonasFromDir` when the file is loaded.
 */
export const parsePersonaMd = (
  id: string,
  content: string
): DronePersonaDefinition => _parsePersonaMdInternal(id, content);

/**
 * Load all personas from user and project directories.
 * Project-level personas override user-level personas with the same id.
 */
export async function loadPersonas(
  projectDir: string
): Promise<Map<string, DronePersonaDefinition>> {
  const userDir = path.join(os.homedir(), CONFIG_DIR, PERSONA_DIR);
  const projectPersonaDir = path.join(projectDir, CONFIG_DIR, PERSONA_DIR);

  const userPersonas = await loadPersonasFromDir(userDir, 'user');
  const projectPersonas = await loadPersonasFromDir(
    projectPersonaDir,
    'project'
  );

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
