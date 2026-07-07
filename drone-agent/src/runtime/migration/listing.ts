/**
 * Migration Service — asset listing functions.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import {
  getPersonaDir,
  getSkillsDir,
  getInsightsDir,
  getPrinciplesDir,
} from './paths.js';
import { getBeaconUrl } from './helpers.js';
import { getBeaconEndpoint } from './beacon-client.js';
import { extractFrontmatterField } from './frontmatter.js';
import type { AssetType, LocalScope, SwarmScope, AssetInfo } from './types.js';

/**
 * List all local personas in a given scope.
 */
export async function listLocalPersonas(
  scope: LocalScope
): Promise<AssetInfo[]> {
  const dir = getPersonaDir(scope);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const assets: AssetInfo[] = [];
  for (const entry of entries) {
    const personaFile = path.join(dir, entry, 'persona.md');
    try {
      await access(personaFile, fsConstants.F_OK);
    } catch {
      continue;
    }
    const content = await readFile(personaFile, 'utf-8');
    const name = extractFrontmatterField(content, 'name') ?? entry;
    const description =
      extractFrontmatterField(content, 'description') ?? `Persona: ${entry}`;
    assets.push({
      type: 'persona',
      id: entry,
      scope,
      name,
      description,
      filePath: personaFile,
    });
  }
  return assets;
}

/**
 * List all local skills in a given scope.
 */
export async function listLocalSkills(scope: LocalScope): Promise<AssetInfo[]> {
  const dir = getSkillsDir(scope);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const assets: AssetInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const id = entry.slice(0, -3);
    const filePath = path.join(dir, entry);
    const content = await readFile(filePath, 'utf-8');
    const name = extractFrontmatterField(content, 'name') ?? id;
    const description =
      extractFrontmatterField(content, 'description') ?? `Skill: ${id}`;
    assets.push({
      type: 'skill',
      id,
      scope,
      name,
      description,
      filePath,
    });
  }
  return assets;
}

/**
 * List all local insights for a given scope.
 * Insights are stored as JSON files in .drone-agent/insights/<targetType>/<targetId>.json
 */
export async function listLocalInsights(
  scope: LocalScope
): Promise<AssetInfo[]> {
  const dir = getInsightsDir(scope);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const assets: AssetInfo[] = [];
  for (const targetType of entries) {
    const typeDir = path.join(dir, targetType);
    let files: string[];
    try {
      files = await readdir(typeDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      const filePath = path.join(typeDir, file);
      assets.push({
        type: 'insight',
        id,
        scope,
        name: `${targetType}/${id}`,
        description: `Insights for ${targetType} "${id}"`,
        filePath,
      });
    }
  }
  return assets;
}

/**
 * List all local principles for a given scope.
 * Principles are stored as JSON files in .drone-agent/principles/<targetType>/<targetId>.json
 */
export async function listLocalPrinciples(
  scope: LocalScope
): Promise<AssetInfo[]> {
  const dir = getPrinciplesDir(scope);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const assets: AssetInfo[] = [];
  for (const targetType of entries) {
    const typeDir = path.join(dir, targetType);
    let files: string[];
    try {
      files = await readdir(typeDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      const filePath = path.join(typeDir, file);
      assets.push({
        type: 'principle',
        id,
        scope,
        name: `${targetType}/${id}`,
        description: `Principles for ${targetType} "${id}"`,
        filePath,
      });
    }
  }
  return assets;
}

/**
 * List all assets from a beacon (local + proxied coordinator).
 */
export async function listBeaconAssets(
  type: AssetType,
  beaconHost?: string,
  beaconPort?: number
): Promise<AssetInfo[]> {
  const baseUrl = getBeaconUrl(beaconHost, beaconPort);
  const endpoint = getBeaconEndpoint(type);
  try {
    const res = await fetch(`${baseUrl}${endpoint}`);
    if (!res.ok) return [];
    const data = (await res.json()) as Array<Record<string, unknown>>;
    return data.map((item: Record<string, unknown>) => ({
      type,
      id: String(item.id ?? ''),
      scope: (String(item.scope ?? 'beacon') === 'coordinator'
        ? 'coordinator'
        : 'beacon') as SwarmScope,
      name: String(item.name ?? item.id ?? ''),
      description: String(item.description ?? ''),
    }));
  } catch {
    return [];
  }
}
