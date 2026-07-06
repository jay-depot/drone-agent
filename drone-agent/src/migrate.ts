/**
 * drone-migrate — CLI entry point for the migration tool.
 *
 * This is the main entry point for the `drone-migrate` bin stub and the
 * `drone-agent migrate` subcommand. It parses CLI args, loads config,
 * and runs the requested migration operation.
 */

import { loadAgentConfig } from './runtime/config.js';
import { type MigrateCliOptions } from './cli.js';
import {
  listAllAssets,
  migrateAsset,
  batchMigrate,
  resolveBeaconAddress,
  type MigrateOptions,
  type AssetType,
  type MigrateScope,
} from './runtime/migration/index.js';

function formatAssetList(
  assets: Array<{
    type: string;
    id: string;
    scope: string;
    name: string;
    description: string;
  }>
): string {
  if (assets.length === 0) {
    return 'No migratable assets found.';
  }

  const lines: string[] = [];
  let currentType = '';

  for (const asset of assets) {
    if (asset.type !== currentType) {
      currentType = asset.type;
      lines.push(`\n${currentType.toUpperCase()}:`);
    }
    lines.push(
      `  [${asset.scope}] ${asset.id} — ${asset.name}: ${asset.description}`
    );
  }

  return lines.join('\n');
}

function formatResults(
  results: Array<{
    success: boolean;
    assetType: string;
    assetId: string;
    fromScope: string;
    toScope: string;
    error?: string;
  }>
): string {
  const lines: string[] = [];
  let successCount = 0;
  let failCount = 0;

  for (const r of results) {
    if (r.success) {
      successCount++;
      lines.push(
        `✓ ${r.assetType} "${r.assetId}": ${r.fromScope} → ${r.toScope}`
      );
    } else {
      failCount++;
      lines.push(
        `✗ ${r.assetType} "${r.assetId}": ${r.fromScope} → ${r.toScope} — ${r.error}`
      );
    }
  }

  lines.push(`\n${successCount} succeeded, ${failCount} failed`);
  return lines.join('\n');
}

export async function runMigrate(
  migrateOptions: MigrateCliOptions,
  configDir?: string
): Promise<void> {
  // Load config to get beacon host/port
  const resolvedConfig = await loadAgentConfig(process.cwd(), { configDir });
  const config = resolvedConfig.config;

  // Resolve beacon address
  const beaconAddr = resolveBeaconAddress(
    config,
    migrateOptions.beaconHost,
    migrateOptions.beaconPort
  );

  // --list: show all migratable assets
  if (migrateOptions.list) {
    const assets = await listAllAssets(beaconAddr?.host, beaconAddr?.port);
    console.log(formatAssetList(assets));
    return;
  }

  // If no beacon config and we need one, error helpfully
  if (!beaconAddr && !migrateOptions.list) {
    console.error(
      'Error: No beacon configuration found.\n' +
        'Set swarm.beaconHost and swarm.beaconPort in your .drone-agent/config.json,\n' +
        'or pass --beacon-host and --beacon-port flags.'
    );
    process.exitCode = 1;
    return;
  }

  const opts: MigrateOptions = {
    type: migrateOptions.type as AssetType | undefined,
    id: migrateOptions.id,
    from: migrateOptions.from as MigrateScope | undefined,
    to: (migrateOptions.to ?? 'beacon') as MigrateScope,
    move: migrateOptions.move,
    backupTo: migrateOptions.backupTo,
    pull: migrateOptions.pull,
    scope: migrateOptions.scope as MigrateScope | undefined,
    beaconHost: beaconAddr?.host,
    beaconPort: beaconAddr?.port,
  };

  // Batch mode: --type with --from or --pull
  if (opts.type && (opts.from || opts.pull) && !opts.id) {
    const results = await batchMigrate(opts);
    console.log(formatResults(results));
    if (results.some(r => !r.success)) {
      process.exitCode = 1;
    }
    return;
  }

  // Single asset migration
  if (opts.type && opts.id) {
    const result = await migrateAsset(opts);
    console.log(formatResults([result]));
    if (!result.success) {
      process.exitCode = 1;
    }
    return;
  }

  // No valid operation specified
  console.error(
    'Usage: drone-migrate <options>\n\n' +
      'Options:\n' +
      '  --list                          List all migratable assets\n' +
      '  --type <type>                   Asset type (persona|skill|insight|principle|wiki)\n' +
      '  --id <id>                       Specific asset id to migrate\n' +
      '  --from <scope>                  Source scope (project|user|beacon|coordinator)\n' +
      '  --to <scope>                    Target scope (beacon|coordinator|project|user)\n' +
      '  --move                          Delete source after successful copy\n' +
      '  --backup-to <path>              Backup asset file before migrating\n' +
      '  --pull                          Pull from swarm to local (demote)\n' +
      '  --scope <scope>                 Source scope for pull operations\n' +
      '  --beacon-host <host>            Beacon host override\n' +
      '  --beacon-port <port>            Beacon port override\n\n' +
      'Examples:\n' +
      '  drone-migrate --list\n' +
      '  drone-migrate --type persona --id my-persona --to beacon\n' +
      '  drone-migrate --type skill --id deploy-helm --to coordinator\n' +
      '  drone-migrate --type persona --from user --to beacon\n' +
      '  drone-migrate --pull --type persona --scope coordinator --to user\n' +
      '  drone-migrate --type wiki --id my-page --to coordinator\n'
  );
  process.exitCode = 1;
}
