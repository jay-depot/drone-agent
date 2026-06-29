/**
 * Migration Service — promote/demote identity assets between scopes.
 *
 * Supports:
 *   - Personas (project, user → beacon, coordinator)
 *   - Skills (project, user → beacon, coordinator)
 *   - Insights (project, user → beacon, coordinator)
 *   - Principles (project, user → beacon, coordinator)
 *   - Wiki pages (beacon ↔ coordinator, server-to-server only)
 *
 * Memory migration is deferred (different storage model).
 * Conversation log import is a phase 5 concern.
 */

import { readFile, writeFile, unlink, readdir, access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DroneAgentConfig } from 'drone-core';

// ── Types ──────────────────────────────────────────────────────────────

export type AssetType = 'persona' | 'skill' | 'insight' | 'principle' | 'wiki';

export type LocalScope = 'project' | 'user';
export type SwarmScope = 'beacon' | 'coordinator';
export type MigrateScope = LocalScope | SwarmScope;

export interface MigrateOptions {
  /** Type of asset to migrate. */
  type?: AssetType;
  /** Specific asset id to migrate (omit for batch). */
  id?: string;
  /** Source scope (for batch or demote). */
  from?: MigrateScope;
  /** Target scope. */
  to: MigrateScope;
  /** When true, delete source after successful copy. */
  move?: boolean;
  /** Optional backup path — write raw asset file before migrating. */
  backupTo?: string;
  /** When true, pull from swarm to local (demote). */
  pull?: boolean;
  /** Source scope for pull operations. */
  scope?: MigrateScope;
  /** Beacon host override. */
  beaconHost?: string;
  /** Beacon port override. */
  beaconPort?: number;
}

export interface AssetInfo {
  type: AssetType;
  id: string;
  scope: MigrateScope;
  name: string;
  description: string;
  /** Path to the local file (for local assets). */
  filePath?: string;
}

export interface MigrateResult {
  success: boolean;
  assetType: AssetType;
  assetId: string;
  fromScope: MigrateScope;
  toScope: MigrateScope;
  error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const CONFIG_DIR = '.drone-agent';
const PERSONA_DIR = 'personas';
const SKILLS_DIR = 'skills';
const INSIGHTS_DIR = 'insights';
const PRINCIPLES_DIR = 'principles';

const DEFAULT_BEACON_HOST = 'localhost';
const DEFAULT_BEACON_PORT = 3457;

// ── Helpers ────────────────────────────────────────────────────────────

function getProjectDir(): string {
  return process.cwd();
}

function getUserDir(): string {
  return os.homedir();
}

function getLocalBaseDir(scope: LocalScope): string {
  return scope === 'user' ? getUserDir() : getProjectDir();
}

function getBeaconUrl(host?: string, port?: number): string {
  const h = host ?? DEFAULT_BEACON_HOST;
  const p = port ?? DEFAULT_BEACON_PORT;
  return `http://${h}:${p}`;
}

function getConfigBeaconHost(config?: DroneAgentConfig): string | undefined {
  return config?.swarm?.beaconHost;
}

function getConfigBeaconPort(config?: DroneAgentConfig): number | undefined {
  return config?.swarm?.beaconPort;
}

// ── Local filesystem paths ─────────────────────────────────────────────

function getPersonaDir(scope: LocalScope): string {
  return path.join(getLocalBaseDir(scope), CONFIG_DIR, PERSONA_DIR);
}

function getPersonaFilePath(scope: LocalScope, id: string): string {
  return path.join(getPersonaDir(scope), id, 'persona.md');
}

function getSkillsDir(scope: LocalScope): string {
  return path.join(getLocalBaseDir(scope), CONFIG_DIR, SKILLS_DIR);
}

function getSkillFilePath(scope: LocalScope, id: string): string {
  return path.join(getSkillsDir(scope), `${id}.md`);
}

function getInsightsDir(scope: LocalScope): string {
  return path.join(getLocalBaseDir(scope), CONFIG_DIR, INSIGHTS_DIR);
}

function getPrinciplesDir(scope: LocalScope): string {
  return path.join(getLocalBaseDir(scope), CONFIG_DIR, PRINCIPLES_DIR);
}

// ── Listing assets ─────────────────────────────────────────────────────

/**
 * List all local personas in a given scope.
 */
async function listLocalPersonas(scope: LocalScope): Promise<AssetInfo[]> {
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
    const description = extractFrontmatterField(content, 'description') ?? `Persona: ${entry}`;
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
async function listLocalSkills(scope: LocalScope): Promise<AssetInfo[]> {
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
    const description = extractFrontmatterField(content, 'description') ?? `Skill: ${id}`;
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
async function listLocalInsights(scope: LocalScope): Promise<AssetInfo[]> {
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
async function listLocalPrinciples(scope: LocalScope): Promise<AssetInfo[]> {
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
async function listBeaconAssets(
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
      scope: (String(item.scope ?? 'beacon') === 'coordinator' ? 'coordinator' : 'beacon') as SwarmScope,
      name: String(item.name ?? item.id ?? ''),
      description: String(item.description ?? ''),
    }));
  } catch {
    return [];
  }
}

// ── Beacon HTTP helpers ────────────────────────────────────────────────

function getBeaconEndpoint(type: AssetType): string {
  switch (type) {
    case 'persona': return '/personas';
    case 'skill': return '/skills';
    case 'insight': return '/insights';
    case 'principle': return '/principles';
    case 'wiki': return '/wiki';
  }
}

function getBeaconItemEndpoint(type: AssetType, id: string): string {
  return `${getBeaconEndpoint(type)}/${encodeURIComponent(id)}`;
}

/**
 * Read a single asset from the beacon (or proxied coordinator).
 */
async function fetchBeaconAsset(
  type: AssetType,
  id: string,
  scope?: SwarmScope,
  beaconHost?: string,
  beaconPort?: number
): Promise<Record<string, unknown> | null> {
  const baseUrl = getBeaconUrl(beaconHost, beaconPort);
  const endpoint = getBeaconItemEndpoint(type, id);
  const query = scope ? `?scope=${scope}` : '';
  try {
    const res = await fetch(`${baseUrl}${endpoint}${query}`);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * POST an asset to the beacon.
 */
async function postBeaconAsset(
  type: AssetType,
  body: Record<string, unknown>,
  scope?: SwarmScope,
  beaconHost?: string,
  beaconPort?: number
): Promise<boolean> {
  const baseUrl = getBeaconUrl(beaconHost, beaconPort);
  const endpoint = getBeaconEndpoint(type);
  const payload = scope ? { ...body, scope } : body;
  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * PUT an asset to the beacon (for wiki pages which use PUT).
 */
async function putBeaconAsset(
  type: AssetType,
  id: string,
  body: Record<string, unknown>,
  scope?: SwarmScope,
  beaconHost?: string,
  beaconPort?: number
): Promise<boolean> {
  const baseUrl = getBeaconUrl(beaconHost, beaconPort);
  const endpoint = getBeaconItemEndpoint(type, id);
  const payload = scope ? { ...body, scope } : body;
  try {
    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * DELETE an asset from the beacon.
 */
async function deleteBeaconAsset(
  type: AssetType,
  id: string,
  scope?: SwarmScope,
  beaconHost?: string,
  beaconPort?: number
): Promise<boolean> {
  const baseUrl = getBeaconUrl(beaconHost, beaconPort);
  const endpoint = getBeaconItemEndpoint(type, id);
  const query = scope ? `?scope=${scope}` : '';
  try {
    const res = await fetch(`${baseUrl}${endpoint}${query}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Frontmatter extraction ─────────────────────────────────────────────

/**
 * Extract a simple YAML frontmatter field value from a .md file.
 */
function extractFrontmatterField(content: string, field: string): string | undefined {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  const frontmatter = match[1];
  const lineMatch = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (!lineMatch) return undefined;
  return lineMatch[1].trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
}

// ── Backup ─────────────────────────────────────────────────────────────

async function backupAsset(filePath: string, backupPath: string): Promise<void> {
  const content = await readFile(filePath, 'utf-8');
  const dir = path.dirname(backupPath);
  await mkdir(dir, { recursive: true });
  await writeFile(backupPath, content, 'utf-8');
}

// ── Migration operations ───────────────────────────────────────────────

/**
 * Promote a local asset to a swarm scope.
 */
async function promoteAsset(
  type: AssetType,
  id: string,
  fromScope: LocalScope,
  toScope: SwarmScope,
  options: MigrateOptions
): Promise<MigrateResult> {
  try {
    // Read local file
    let filePath: string;
    let content: string;

    if (type === 'persona') {
      filePath = getPersonaFilePath(fromScope, id);
    } else if (type === 'skill') {
      filePath = getSkillFilePath(fromScope, id);
    } else if (type === 'insight') {
      filePath = path.join(getInsightsDir(fromScope), id);
    } else if (type === 'principle') {
      filePath = path.join(getPrinciplesDir(fromScope), id);
    } else {
      return { success: false, assetType: type, assetId: id, fromScope, toScope, error: `Unsupported asset type for promotion: ${type}` };
    }

    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return { success: false, assetType: type, assetId: id, fromScope, toScope, error: `Local asset not found: ${filePath}` };
    }

    // Backup if requested
    if (options.backupTo) {
      await backupAsset(filePath, options.backupTo);
    }

    // Build the payload for the beacon
    let payload: Record<string, unknown> = {};
    if (type === 'persona') {
      const name = extractFrontmatterField(content, 'name') ?? id;
      const description = extractFrontmatterField(content, 'description') ?? `Persona: ${id}`;
      payload = { id, name, description, systemPrompt: content };
    } else if (type === 'skill') {
      const name = extractFrontmatterField(content, 'name') ?? id;
      const description = extractFrontmatterField(content, 'description') ?? `Skill: ${id}`;
      const trigger = extractFrontmatterField(content, 'recall') ?? '';
      payload = { id, name, description, trigger, body: content };
    } else if (type === 'insight') {
      // Insights are JSON arrays — read and post each entry
      const insights = JSON.parse(content);
      if (!Array.isArray(insights)) {
        return { success: false, assetType: type, assetId: id, fromScope, toScope, error: 'Insight file must be a JSON array' };
      }
      for (const insight of insights) {
        const ok = await postBeaconAsset(type, {
          targetType: insight.targetType ?? 'project',
          targetId: insight.targetId ?? id,
          insight: insight.insight,
        }, toScope, options.beaconHost, options.beaconPort);
        if (!ok) {
          return { success: false, assetType: type, assetId: id, fromScope, toScope, error: `Failed to post insight to ${toScope}` };
        }
      }
      // Move/backup handled below
    } else if (type === 'principle') {
      // Principles are JSON arrays — read and post each entry
      const principles = JSON.parse(content);
      if (!Array.isArray(principles)) {
        return { success: false, assetType: type, assetId: id, fromScope, toScope, error: 'Principle file must be a JSON array' };
      }
      for (const principle of principles) {
        const ok = await postBeaconAsset(type, {
          targetType: principle.targetType ?? 'project',
          targetId: principle.targetId ?? id,
          principle: principle.principle,
          source: principle.source,
        }, toScope, options.beaconHost, options.beaconPort);
        if (!ok) {
          return { success: false, assetType: type, assetId: id, fromScope, toScope, error: `Failed to post principle to ${toScope}` };
        }
      }
    }

    // For persona/skill, POST to beacon
    if (type === 'persona' || type === 'skill') {
      const ok = await postBeaconAsset(type, payload, toScope, options.beaconHost, options.beaconPort);
      if (!ok) {
        return { success: false, assetType: type, assetId: id, fromScope, toScope, error: `Failed to post ${type} to ${toScope}` };
      }
    }

    // Move: delete local source
    if (options.move) {
      try {
        await unlink(filePath);
      } catch (err) {
        return { success: false, assetType: type, assetId: id, fromScope, toScope, error: `Failed to delete source: ${err}` };
      }
    }

    return { success: true, assetType: type, assetId: id, fromScope, toScope };
  } catch (err) {
    return { success: false, assetType: type, assetId: id, fromScope, toScope, error: String(err) };
  }
}

/**
 * Demote a swarm asset to a local scope.
 */
async function demoteAsset(
  type: AssetType,
  id: string,
  fromScope: SwarmScope,
  toScope: LocalScope,
  options: MigrateOptions
): Promise<MigrateResult> {
  try {
    // Fetch from beacon
    const data = await fetchBeaconAsset(type, id, fromScope, options.beaconHost, options.beaconPort);
    if (!data) {
      return { success: false, assetType: type, assetId: id, fromScope, toScope, error: `Asset not found on ${fromScope}` };
    }

    // Build local file content
    let filePath: string;
    let content: string;

    if (type === 'persona') {
      const dir = getPersonaDir(toScope);
      filePath = getPersonaFilePath(toScope, id);
      const name = String(data.name ?? id);
      const description = String(data.description ?? `Persona: ${id}`);
      const systemPrompt = String(data.systemPrompt ?? '');
      content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${systemPrompt}`;
    } else if (type === 'skill') {
      filePath = getSkillFilePath(toScope, id);
      const name = String(data.name ?? id);
      const description = String(data.description ?? `Skill: ${id}`);
      const body = String(data.body ?? '');
      content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
    } else if (type === 'insight') {
      filePath = path.join(getInsightsDir(toScope), `${id}.json`);
      content = JSON.stringify(data, null, 2);
    } else if (type === 'principle') {
      filePath = path.join(getPrinciplesDir(toScope), `${id}.json`);
      content = JSON.stringify(data, null, 2);
    } else {
      return { success: false, assetType: type, assetId: id, fromScope, toScope, error: `Unsupported asset type for demotion: ${type}` };
    }

    // Backup if requested
    if (options.backupTo) {
      const dir = path.dirname(options.backupTo);
      await mkdir(dir, { recursive: true });
      await writeFile(options.backupTo, content, 'utf-8');
    }

    // Write local file
    const dir = path.dirname(filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, content, 'utf-8');

    // Move: delete from server
    if (options.move) {
      const ok = await deleteBeaconAsset(type, id, fromScope, options.beaconHost, options.beaconPort);
      if (!ok) {
        return { success: false, assetType: type, assetId: id, fromScope, toScope, error: `Failed to delete from ${fromScope}` };
      }
    }

    return { success: true, assetType: type, assetId: id, fromScope, toScope };
  } catch (err) {
    return { success: false, assetType: type, assetId: id, fromScope, toScope, error: String(err) };
  }
}

/**
 * Migrate a wiki page between swarm scopes (beacon ↔ coordinator).
 */
async function migrateWikiPage(
  id: string,
  fromScope: SwarmScope,
  toScope: SwarmScope,
  options: MigrateOptions
): Promise<MigrateResult> {
  try {
    // Fetch from source
    const data = await fetchBeaconAsset('wiki', id, fromScope, options.beaconHost, options.beaconPort);
    if (!data) {
      return { success: false, assetType: 'wiki', assetId: id, fromScope, toScope, error: `Wiki page not found on ${fromScope}` };
    }

    // Backup if requested
    if (options.backupTo) {
      const dir = path.dirname(options.backupTo);
      await mkdir(dir, { recursive: true });
      await writeFile(options.backupTo, JSON.stringify(data, null, 2), 'utf-8');
    }

    // PUT to target
    const ok = await putBeaconAsset('wiki', id, {
      title: data.title,
      content: data.content,
      tags: data.tags,
      sources: data.sources,
    }, toScope, options.beaconHost, options.beaconPort);

    if (!ok) {
      return { success: false, assetType: 'wiki', assetId: id, fromScope, toScope, error: `Failed to write wiki page to ${toScope}` };
    }

    // Move: delete from source
    if (options.move) {
      const deleted = await deleteBeaconAsset('wiki', id, fromScope, options.beaconHost, options.beaconPort);
      if (!deleted) {
        return { success: false, assetType: 'wiki', assetId: id, fromScope, toScope, error: `Failed to delete wiki page from ${fromScope}` };
      }
    }

    return { success: true, assetType: 'wiki', assetId: id, fromScope, toScope };
  } catch (err) {
    return { success: false, assetType: 'wiki', assetId: id, fromScope, toScope, error: String(err) };
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * List all migratable assets across all scopes.
 */
export async function listAllAssets(
  beaconHost?: string,
  beaconPort?: number
): Promise<AssetInfo[]> {
  const all: AssetInfo[] = [];

  // Local scopes
  for (const scope of ['project', 'user'] as LocalScope[]) {
    all.push(...await listLocalPersonas(scope));
    all.push(...await listLocalSkills(scope));
    all.push(...await listLocalInsights(scope));
    all.push(...await listLocalPrinciples(scope));
  }

  // Swarm scopes (if beacon is reachable)
  for (const type of ['persona', 'skill', 'insight', 'principle', 'wiki'] as AssetType[]) {
    all.push(...await listBeaconAssets(type, beaconHost, beaconPort));
  }

  return all;
}

/**
 * Execute a single asset migration.
 */
export async function migrateAsset(options: MigrateOptions): Promise<MigrateResult> {
  const { type, id, from, to, pull, scope } = options;

  if (!type) {
    return { success: false, assetType: 'persona', assetId: '', fromScope: 'project', toScope: 'beacon', error: 'Asset type is required' };
  }

  if (!id) {
    return { success: false, assetType: type, assetId: '', fromScope: 'project', toScope: 'beacon', error: 'Asset id is required' };
  }

  // Wiki pages are server-to-server only
  if (type === 'wiki') {
    const fromScope = (scope ?? from ?? 'beacon') as SwarmScope;
    const toScope = to as SwarmScope;
    if ((fromScope as string) === 'project' || (fromScope as string) === 'user' || (toScope as string) === 'project' || (toScope as string) === 'user') {
      return { success: false, assetType: type, assetId: id, fromScope, toScope, error: 'Wiki pages are server-to-server only (beacon ↔ coordinator)' };
    }
    return migrateWikiPage(id, fromScope, toScope, options);
  }

  // Pull: swarm → local
  if (pull) {
    const fromScope = (scope ?? 'beacon') as SwarmScope;
    const toScope = to as LocalScope;
    if (toScope !== 'project' && toScope !== 'user') {
      return { success: false, assetType: type, assetId: id, fromScope, toScope, error: 'Pull target must be project or user' };
    }
    return demoteAsset(type, id, fromScope, toScope, options);
  }

  // Promote: local → swarm
  const fromScope = (from ?? 'project') as LocalScope;
  const toScope = to as SwarmScope;
  if (fromScope !== 'project' && fromScope !== 'user') {
    return { success: false, assetType: type, assetId: id, fromScope, toScope, error: 'Promote source must be project or user' };
  }
  if (toScope !== 'beacon' && toScope !== 'coordinator') {
    return { success: false, assetType: type, assetId: id, fromScope, toScope, error: 'Promote target must be beacon or coordinator' };
  }
  return promoteAsset(type, id, fromScope, toScope, options);
}

/**
 * Batch migrate all assets of a given type from one scope to another.
 */
export async function batchMigrate(options: MigrateOptions): Promise<MigrateResult[]> {
  const { type, from, to, pull, scope } = options;

  if (!type) {
    return [{ success: false, assetType: 'persona', assetId: '', fromScope: 'project', toScope: 'beacon', error: 'Asset type is required for batch' }];
  }

  const results: MigrateResult[] = [];

  if (pull) {
    // Batch demote: swarm → local
    const fromScope = (scope ?? 'beacon') as SwarmScope;
    const toScope = to as LocalScope;
    if (toScope !== 'project' && toScope !== 'user') {
      return [{ success: false, assetType: type, assetId: '', fromScope, toScope, error: 'Pull target must be project or user' }];
    }

    const assets = await listBeaconAssets(type, options.beaconHost, options.beaconPort);
    for (const asset of assets) {
      if (asset.scope !== fromScope) continue;
      const result = await demoteAsset(type, asset.id, fromScope, toScope, options);
      results.push(result);
    }
  } else {
    // Batch promote: local → swarm
    const fromScope = (from ?? 'project') as LocalScope;
    const toScope = to as SwarmScope;
    if (fromScope !== 'project' && fromScope !== 'user') {
      return [{ success: false, assetType: type, assetId: '', fromScope, toScope, error: 'Promote source must be project or user' }];
    }
    if (toScope !== 'beacon' && toScope !== 'coordinator') {
      return [{ success: false, assetType: type, assetId: '', fromScope, toScope, error: 'Promote target must be beacon or coordinator' }];
    }

    let localAssets: AssetInfo[];
    switch (type) {
      case 'persona':
        localAssets = await listLocalPersonas(fromScope);
        break;
      case 'skill':
        localAssets = await listLocalSkills(fromScope);
        break;
      case 'insight':
        localAssets = await listLocalInsights(fromScope);
        break;
      case 'principle':
        localAssets = await listLocalPrinciples(fromScope);
        break;
      default:
        return [{ success: false, assetType: type, assetId: '', fromScope, toScope, error: `Unsupported batch type: ${type}` }];
    }

    for (const asset of localAssets) {
      const result = await promoteAsset(type, asset.id, fromScope, toScope, options);
      results.push(result);
    }
  }

  return results;
}

/**
 * Resolve beacon host/port from config or CLI overrides.
 */
export function resolveBeaconAddress(
  config?: DroneAgentConfig,
  cliHost?: string,
  cliPort?: number
): { host: string; port: number } | null {
  const host = cliHost ?? getConfigBeaconHost(config);
  const port = cliPort ?? getConfigBeaconPort(config);

  if (!host || !port) {
    return null;
  }

  return { host, port };
}
