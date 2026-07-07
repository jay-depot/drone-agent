/**
 * Migration Service — barrel export.
 *
 * Re-exports the public API: listAllAssets, migrateAsset, batchMigrate,
 * resolveBeaconAddress, and all types.
 */

export {
  listAllAssets,
  migrateAsset,
  batchMigrate,
  resolveBeaconAddress,
} from './public-api.js';
export type {
  AssetType,
  LocalScope,
  SwarmScope,
  MigrateScope,
  MigrateOptions,
  AssetInfo,
  MigrateResult,
} from './types.js';
