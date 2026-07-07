/**
 * Migration Service — demote a swarm asset to a local scope.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  getPersonaFilePath,
  getSkillFilePath,
  getInsightsDir,
  getPrinciplesDir,
} from './paths.js';
import { fetchBeaconAsset, deleteBeaconAsset } from './beacon-client.js';
import type {
  AssetType,
  LocalScope,
  SwarmScope,
  MigrateOptions,
  MigrateResult,
} from './types.js';

/**
 * Demote a swarm asset to a local scope.
 */
export async function demoteAsset(
  type: AssetType,
  id: string,
  fromScope: SwarmScope,
  toScope: LocalScope,
  options: MigrateOptions
): Promise<MigrateResult> {
  try {
    // Fetch from beacon
    const data = await fetchBeaconAsset(
      type,
      id,
      fromScope,
      options.beaconHost,
      options.beaconPort
    );
    if (!data) {
      return {
        success: false,
        assetType: type,
        assetId: id,
        fromScope,
        toScope,
        error: `Asset not found on ${fromScope}`,
      };
    }

    // Build local file content
    let filePath: string;
    let content: string;

    if (type === 'persona') {
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
      return {
        success: false,
        assetType: type,
        assetId: id,
        fromScope,
        toScope,
        error: `Unsupported asset type for demotion: ${type}`,
      };
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
      const ok = await deleteBeaconAsset(
        type,
        id,
        fromScope,
        options.beaconHost,
        options.beaconPort
      );
      if (!ok) {
        return {
          success: false,
          assetType: type,
          assetId: id,
          fromScope,
          toScope,
          error: `Failed to delete from ${fromScope}`,
        };
      }
    }

    return { success: true, assetType: type, assetId: id, fromScope, toScope };
  } catch (err) {
    return {
      success: false,
      assetType: type,
      assetId: id,
      fromScope,
      toScope,
      error: String(err),
    };
  }
}
