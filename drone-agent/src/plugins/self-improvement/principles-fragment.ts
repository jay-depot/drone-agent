import path from 'node:path';
import type {
  DronePersonaCapability,
  DronePrincipleEntry,
  DronePrincipleStorageEngine,
} from 'drone-core';
import { CONFIG_DIR, PRINCIPLES_SUBDIR } from './constants.js';
import { readJsonArray, scanJsonDir } from './io.js';
import { resolvePrincipleEngine } from './capability.js';

/**
 * Render the combined principles prompt fragment (footer).
 * Includes project-level and active-persona-level principles.
 */
export async function renderPrinciplesFragment(
  projectDir: string,
  personaCap?: DronePersonaCapability,
  defaultPrincipleEngine?: DronePrincipleStorageEngine
): Promise<string | false> {
  const sections: string[] = [];

  // ── Project Principles ───────────────────────────────────────
  const projectPrinciplesDir = path.join(
    projectDir,
    CONFIG_DIR,
    PRINCIPLES_SUBDIR,
    'project'
  );
  const projectFiles =
    await scanJsonDir<DronePrincipleEntry>(projectPrinciplesDir);

  const haveProject = projectFiles.length > 0;
  const activePersona = personaCap?.getActivePersona();
  const havePersona = !!activePersona;

  if (haveProject || havePersona) {
    sections.push('# Principles');
    sections.push(
      '**You have learned the following principles from your prior experiences. Let them guide your decisions.**'
    );

    if (haveProject) {
      const projectLines: string[] = ['## Current Project'];
      for (const file of projectFiles) {
        const filePath = path.join(projectPrinciplesDir, `${file.id}.json`);
        const principles = await readJsonArray<DronePrincipleEntry>(filePath);
        if (principles.length > 0) {
          projectLines.push(`### ${file.id}`);
          for (const p of principles) {
            projectLines.push(`- ${p.principle}`);
          }
        }
      }
      if (projectLines.length > 1) {
        sections.push(projectLines.join('\n'));
      }
    }

    // ── Persona Principles ────────────────────────────────────────
    if (havePersona && defaultPrincipleEngine) {
      const engine = resolvePrincipleEngine(
        'persona',
        activePersona.id,
        defaultPrincipleEngine,
        personaCap
      );
      const principles = await engine.readPrinciples(
        'persona',
        activePersona.id
      );

      if (principles.length > 0) {
        const personaLines = ['## Current Persona'];
        personaLines.push(`### ${activePersona.id}`);
        for (const p of principles) {
          personaLines.push(`- ${p.principle}`);
        }
        sections.push(personaLines.join('\n'));
      }
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : false;
}
