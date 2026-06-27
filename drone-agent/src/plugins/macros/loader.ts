import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DroneMacroDefinition, DroneLogger } from 'drone-core';
import { parseMacroFile } from './parser.js';

const MACRO_DIR = 'macros';
const CONFIG_DIR = '.drone-agent';

/**
 * Load all .macro files from a given directory.
 * Invalid files are skipped with a warning logged via the provided logger.
 */
async function loadMacrosFromDir(
  dir: string,
  logger?: DroneLogger
): Promise<DroneMacroDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const macros: DroneMacroDefinition[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.macro')) continue;
    const filePath = path.join(dir, entry);
    try {
      const content = await readFile(filePath, 'utf-8');
      macros.push(parseMacroFile(content, filePath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger?.warn(`Skipping invalid macro file "${filePath}": ${message}`);
    }
  }
  return macros;
}

/**
 * Load all macros from user and project directories.
 * Project-level macros override user-level macros with the same command name.
 */
export async function loadMacros(
  projectDir: string,
  logger?: DroneLogger
): Promise<Map<string, DroneMacroDefinition>> {
  const userDir = path.join(os.homedir(), CONFIG_DIR, MACRO_DIR);
  const projectMacroDir = path.join(projectDir, CONFIG_DIR, MACRO_DIR);

  const userMacros = await loadMacrosFromDir(userDir, logger);
  const projectMacros = await loadMacrosFromDir(projectMacroDir, logger);

  const map = new Map<string, DroneMacroDefinition>();
  for (const m of userMacros) {
    map.set(m.command, m);
  }
  // Project overrides user-level macros with the same command.
  for (const m of projectMacros) {
    map.set(m.command, m);
  }

  return map;
}
