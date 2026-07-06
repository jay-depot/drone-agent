/**
 * Migration Service — public API functions.
 *
 * These are the top-level entry points called by migrate.ts and tests.
 */

import type { DroneAgentConfig } from 'drone-core';
import { getConfigBeaconHost, getConfigBeaconPort } from './helpers.js';
import { listLocalPersonas, listLocalSkills, listLocalInsights, listLocalPrinciples, listBeaconAssets } from './listing.js';
import { promoteAsset } from './promote.js';
import { demoteAsset } from './demote.js';
import { migrateWikiPage } from './wiki.js';
import type { AssetType, LocalScope, SwarmScope, AssetInfo, MigrateOptions, MigrateResult } from './types.js';

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
    all.push(...(await listLocalPersonas(scope)));
    all.push(...(await listLocalSkills(scope)));
    all.push(...(await listLocalInsights(scope)));
    all.push(...(await listLocalPrinciples(scope)));
  }

  // Swarm scopes (if beacon is reachable)
  for (const type of [
    'persona',
    'skill',
    'insight',
    'principle',
    'wiki',
  ] as AssetType[]) {
    all.push(...(await listBeaconAssets(type, beaconHost, beaconPort)));
  }

  return all;
}

/**
 * Execute a single asset migration.
 */
export async function migrateAsset(
  options: MigrateOptions
): Promise<MigrateResult> {
  const { type, id, from, to, pull, scope } = options;

  if (!type) {
    return {
      success: false,
      assetType: 'persona',
      assetId: '',
      fromScope: 'project',
      toScope: 'beacon',
      error: 'Asset type is required',
    };
  }

  if (!id) {
    return {
      success: false,
      assetType: type,
      assetId: '',
      fromScope: 'project',
      toScope: 'beacon',
      error: 'Asset id is required',
    };
  }

  // Wiki pages are server-to-server only
  if (type === 'wiki') {
    const fromScope = (scope ?? from ?? 'beacon') as SwarmScope;
    const toScope = to as SwarmScope;
    if (
      (fromScope as string) === 'project' ||
      (fromScope as string) === 'user' ||
      (toScope as string) === 'project' ||
      (toScope as string) === 'user'
    ) {
      return {
        success: false,
        assetType: type,
        assetId: id,
        fromScope,
        toScope,
        error: 'Wiki pages are server-to-server only (beacon ↔ coordinator)',
      };
    }
    return migrateWikiPage(id, fromScope, toScope, options);
  }

  // Pull: swarm → local
  if (pull) {
    const fromScope = (scope ?? 'beacon') as SwarmScope;
    const toScope = to as LocalScope;
    if (toScope !== 'project' && toScope !== 'user') {
      return {
        success: false,
        assetType: type,
        assetId: id,
        fromScope,
        toScope,
        error: 'Pull target must be project or user',
      };
    }
    return demoteAsset(type, id, fromScope, toScope, options);
  }

  // Promote: local → swarm
  const fromScope = (from ?? 'project') as LocalScope;
  const toScope = to as SwarmScope;
  if (fromScope !== 'project' && fromScope !== 'user') {
    return {
      success: false,
      assetType: type,
      assetId: id,
      fromScope,
      toScope,
      error: 'Promote source must be project or user',
    };
  }
  if (toScope !== 'beacon' && toScope !== 'coordinator') {
    return {
      success: false,
      assetType: type,
      assetId: id,
      fromScope,
      toScope,
      error: 'Promote target must be beacon or coordinator',
    };
  }
  return promoteAsset(type, id, fromScope, toScope, options);
}

/**
 * Batch migrate all assets of a given type from one scope to another.
 */
export async function batchMigrate(
  options: MigrateOptions
): Promise<MigrateResult[]> {
  const { type, from, to, pull, scope } = options;

  if (!type) {
    return [
      {
        success: false,
        assetType: 'persona',
        assetId: '',
        fromScope: 'project',
        toScope: 'beacon',
        error: 'Asset type is required for batch',
      },
    ];
  }

  const results: MigrateResult[] = [];

  if (pull) {
    // Batch demote: swarm → local
    const fromScope = (scope ?? 'beacon') as SwarmScope;
    const toScope = to as LocalScope;
    if (toScope !== 'project' && toScope !== 'user') {
      return [
        {
          success: false,
          assetType: type,
          assetId: '',
          fromScope,
          toScope,
          error: 'Pull target must be project or user',
        },
      ];
    }

    const assets = await listBeaconAssets(
      type,
      options.beaconHost,
      options.beaconPort
    );
    for (const asset of assets) {
      if (asset.scope !== fromScope) continue;
      const result = await demoteAsset(
        type,
        asset.id,
        fromScope,
        toScope,
        options
      );
      results.push(result);
    }
  } else {
    // Batch promote: local → swarm
    const fromScope = (from ?? 'project') as LocalScope;
    const toScope = to as SwarmScope;
    if (fromScope !== 'project' && fromScope !== 'user') {
      return [
        {
          success: false,
          assetType: type,
          assetId: '',
          fromScope,
          toScope,
          error: 'Promote source must be project or user',
        },
      ];
    }
    if (toScope !== 'beacon' && toScope !== 'coordinator') {
      return [
        {
          success: false,
          assetType: type,
          assetId: '',
          fromScope,
          toScope,
          error: 'Promote target must be beacon or coordinator',
        },
      ];
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
        return [
          {
            success: false,
            assetType: type,
            assetId: '',
            fromScope,
            toScope,
            error: `Unsupported batch type: ${type}`,
          },
        ];
    }

    for (const asset of localAssets) {
      const result = await promoteAsset(
        type,
        asset.id,
        fromScope,
        toScope,
        options
      );
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
