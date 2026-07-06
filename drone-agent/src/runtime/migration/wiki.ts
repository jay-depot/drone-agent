/**
 * Migration Service — migrate a wiki page between swarm scopes (beacon ↔ coordinator).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fetchBeaconAsset, putBeaconAsset, deleteBeaconAsset } from './beacon-client.js';
import type { SwarmScope, MigrateOptions, MigrateResult } from './types.js';

/**
 * Migrate a wiki page between swarm scopes (beacon ↔ coordinator).
 */
export async function migrateWikiPage(
  id: string,
  fromScope: SwarmScope,
  toScope: SwarmScope,
  options: MigrateOptions
): Promise<MigrateResult> {
  try {
    // Fetch from source
    const data = await fetchBeaconAsset(
      'wiki',
      id,
      fromScope,
      options.beaconHost,
      options.beaconPort
    );
    if (!data) {
      return {
        success: false,
        assetType: 'wiki',
        assetId: id,
        fromScope,
        toScope,
        error: `Wiki page not found on ${fromScope}`,
      };
    }

    // Backup if requested
    if (options.backupTo) {
      const dir = path.dirname(options.backupTo);
      await mkdir(dir, { recursive: true });
      await writeFile(options.backupTo, JSON.stringify(data, null, 2), 'utf-8');
    }

    // PUT to target
    const ok = await putBeaconAsset(
      'wiki',
      id,
      {
        title: data.title,
        content: data.content,
        tags: data.tags,
        sources: data.sources,
      },
      toScope,
      options.beaconHost,
      options.beaconPort
    );

    if (!ok) {
      return {
        success: false,
        assetType: 'wiki',
        assetId: id,
        fromScope,
        toScope,
        error: `Failed to write wiki page to ${toScope}`,
      };
    }

    // Move: delete from source
    if (options.move) {
      const deleted = await deleteBeaconAsset(
        'wiki',
        id,
        fromScope,
        options.beaconHost,
        options.beaconPort
      );
      if (!deleted) {
        return {
          success: false,
          assetType: 'wiki',
          assetId: id,
          fromScope,
          toScope,
          error: `Failed to delete wiki page from ${fromScope}`,
        };
      }
    }

    return {
      success: true,
      assetType: 'wiki',
      assetId: id,
      fromScope,
      toScope,
    };
  } catch (err) {
    return {
      success: false,
      assetType: 'wiki',
      assetId: id,
      fromScope,
      toScope,
      error: String(err),
    };
  }
}
