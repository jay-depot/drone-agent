/**
 * Migration Service — promote a local asset to a swarm scope.
 */

import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  getPersonaFilePath,
  getSkillFilePath,
  getInsightsDir,
  getPrinciplesDir,
} from './paths.js';
import { extractFrontmatterField } from './frontmatter.js';
import { postBeaconAsset } from './beacon-client.js';
import { backupAsset } from './backup.js';
import type {
  AssetType,
  LocalScope,
  SwarmScope,
  MigrateOptions,
  MigrateResult,
} from './types.js';

/**
 * Promote a local asset to a swarm scope.
 */
export async function promoteAsset(
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
      return {
        success: false,
        assetType: type,
        assetId: id,
        fromScope,
        toScope,
        error: `Unsupported asset type for promotion: ${type}`,
      };
    }

    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return {
        success: false,
        assetType: type,
        assetId: id,
        fromScope,
        toScope,
        error: `Local asset not found: ${filePath}`,
      };
    }

    // Backup if requested
    if (options.backupTo) {
      await backupAsset(filePath, options.backupTo);
    }

    // Build the payload for the beacon
    let payload: Record<string, unknown> = {};
    if (type === 'persona') {
      const name = extractFrontmatterField(content, 'name') ?? id;
      const description =
        extractFrontmatterField(content, 'description') ?? `Persona: ${id}`;
      payload = { id, name, description, systemPrompt: content };
    } else if (type === 'skill') {
      const name = extractFrontmatterField(content, 'name') ?? id;
      const description =
        extractFrontmatterField(content, 'description') ?? `Skill: ${id}`;
      const trigger = extractFrontmatterField(content, 'recall') ?? '';
      payload = { id, name, description, trigger, body: content };
    } else if (type === 'insight') {
      // Insights are JSON arrays — read and post each entry
      const insights = JSON.parse(content);
      if (!Array.isArray(insights)) {
        return {
          success: false,
          assetType: type,
          assetId: id,
          fromScope,
          toScope,
          error: 'Insight file must be a JSON array',
        };
      }
      for (const insight of insights) {
        const ok = await postBeaconAsset(
          type,
          {
            targetType: insight.targetType ?? 'project',
            targetId: insight.targetId ?? id,
            insight: insight.insight,
          },
          toScope,
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
            error: `Failed to post insight to ${toScope}`,
          };
        }
      }
      // Move/backup handled below
    } else if (type === 'principle') {
      // Principles are JSON arrays — read and post each entry
      const principles = JSON.parse(content);
      if (!Array.isArray(principles)) {
        return {
          success: false,
          assetType: type,
          assetId: id,
          fromScope,
          toScope,
          error: 'Principle file must be a JSON array',
        };
      }
      for (const principle of principles) {
        const ok = await postBeaconAsset(
          type,
          {
            targetType: principle.targetType ?? 'project',
            targetId: principle.targetId ?? id,
            principle: principle.principle,
            source: principle.source,
          },
          toScope,
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
            error: `Failed to post principle to ${toScope}`,
          };
        }
      }
    }

    // For persona/skill, POST to beacon
    if (type === 'persona' || type === 'skill') {
      const ok = await postBeaconAsset(
        type,
        payload,
        toScope,
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
          error: `Failed to post ${type} to ${toScope}`,
        };
      }
    }

    // Move: delete local source
    if (options.move) {
      try {
        await unlink(filePath);
      } catch (err) {
        return {
          success: false,
          assetType: type,
          assetId: id,
          fromScope,
          toScope,
          error: `Failed to delete source: ${err}`,
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
