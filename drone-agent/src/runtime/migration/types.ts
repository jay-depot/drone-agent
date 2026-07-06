/**
 * Migration Service — shared types for identity asset migration.
 */

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
