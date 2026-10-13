import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type {
  DroneExtensionBundle,
  DroneExtensionManifest,
} from 'drone-core';

export interface ExtensionCapabilityCacheRow {
  nodeId: string;
  manifest: DroneExtensionManifest;
  updatedAt: number;
}

export interface ExtensionBundleRow {
  nodeId: string;
  name: string;
  version: string;
  hash: string;
  path: string;
  updatedAt: number;
}

function rowToCapabilityCache(row: Record<string, unknown>): ExtensionCapabilityCacheRow {
  return {
    nodeId: row.node_id as string,
    manifest: JSON.parse(row.manifest as string) as DroneExtensionManifest,
    updatedAt: row.updated_at as number,
  };
}

function rowToBundle(row: Record<string, unknown>): ExtensionBundleRow {
  return {
    nodeId: row.node_id as string,
    name: row.name as string,
    version: row.version as string,
    hash: row.hash as string,
    path: row.path as string,
    updatedAt: row.updated_at as number,
  };
}

/** Upsert the last-known manifest for a node (cache/debugging aid). */
export function upsertCapabilityCache(
  nodeId: string,
  manifest: DroneExtensionManifest
): void {
  const stmt = getDatabase().prepare(`
    INSERT INTO extension_capabilities (node_id, manifest, updated_at)
    VALUES (@nodeId, @manifest, @updatedAt)
    ON CONFLICT(node_id) DO UPDATE SET
      manifest = excluded.manifest,
      updated_at = excluded.updated_at
  `);
  stmt.run({
    nodeId,
    manifest: JSON.stringify(manifest),
    updatedAt: Date.now(),
  });
  logger.info(`Cached extension manifest for node: ${nodeId}`);
}

export function getCapabilityCache(
  nodeId: string
): ExtensionCapabilityCacheRow | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM extension_capabilities WHERE node_id = ?'
  );
  const row = stmt.get(nodeId) as Record<string, unknown> | undefined;
  return row ? rowToCapabilityCache(row) : undefined;
}

export function listCapabilityCache(): ExtensionCapabilityCacheRow[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM extension_capabilities ORDER BY node_id'
  );
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map(rowToCapabilityCache);
}

export function deleteCapabilityCache(nodeId: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM extension_capabilities WHERE node_id = ?')
    .run(nodeId);
  return result.changes > 0;
}

/** Upsert a bundle's DB row (file storage is the caller's concern). */
export function upsertBundle(row: ExtensionBundleRow): ExtensionBundleRow {
  const stmt = getDatabase().prepare(`
    INSERT INTO extension_bundles (node_id, name, version, hash, path, updated_at)
    VALUES (@nodeId, @name, @version, @hash, @path, @updatedAt)
    ON CONFLICT(node_id, name) DO UPDATE SET
      version = excluded.version,
      hash = excluded.hash,
      path = excluded.path,
      updated_at = excluded.updated_at
  `);
  stmt.run(row);
  return row;
}

export function getBundle(
  nodeId: string,
  name: string
): ExtensionBundleRow | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM extension_bundles WHERE node_id = ? AND name = ?'
  );
  const row = stmt.get(nodeId, name) as Record<string, unknown> | undefined;
  return row ? rowToBundle(row) : undefined;
}

export function deleteBundle(nodeId: string, name: string): boolean {
  const result = getDatabase()
    .prepare('DELETE FROM extension_bundles WHERE node_id = ? AND name = ?')
    .run(nodeId, name);
  if (result.changes > 0) {
    logger.info(`Deleted extension bundle: ${nodeId}/${name}`);
  }
  return result.changes > 0;
}

export function listBundles(nodeId?: string): ExtensionBundleRow[] {
  const stmt = nodeId
    ? getDatabase().prepare(
        'SELECT * FROM extension_bundles WHERE node_id = ? ORDER BY name'
      )
    : getDatabase().prepare('SELECT * FROM extension_bundles ORDER BY node_id, name');
  const rows = (nodeId ? stmt.all(nodeId) : stmt.all()) as Record<
    string,
    unknown
  >[];
  return rows.map(rowToBundle);
}

/** Bundle descriptors (manifest form) for a node's UI listing. */
export function listBundleDescriptors(nodeId: string): DroneExtensionBundle[] {
  return listBundles(nodeId).map(row => ({
    name: row.name,
    version: row.version,
    hash: row.hash,
  }));
}
