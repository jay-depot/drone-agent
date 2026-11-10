import type { BeaconRow, ExtensionRow } from './types';
import { apiFetch } from './api';

/** A beacon the New Project modal can offer. */
export interface PickerBeacon {
  id: string;
  name: string;
  spawnRoots: string[];
  defaultSpawnRoot?: string;
}

/**
 * Load the beacons a project may target.
 *
 * `GET /api/beacons` also returns extension nodes (the coordinator registers
 * each extension node as a beacon). An extension node cannot spawn a session,
 * so it is removed. `GET /api/extensions` reports `isExtension` for this.
 */
export async function loadPickerBeacons(): Promise<PickerBeacon[]> {
  const [beaconsRes, extensionsRes] = await Promise.all([
    apiFetch('/api/beacons'),
    apiFetch('/api/extensions'),
  ]);
  const beacons = beaconsRes.ok
    ? ((await beaconsRes.json()) as BeaconRow[])
    : [];
  const extensions = extensionsRes.ok
    ? ((await extensionsRes.json()) as ExtensionRow[])
    : [];
  const extensionIds = new Set(
    extensions.filter(entry => entry.isExtension).map(entry => entry.nodeId)
  );
  return beacons
    .filter(beacon => beacon.connected && !extensionIds.has(beacon.id))
    .map(beacon => ({
      id: beacon.id,
      name: beacon.name || beacon.id,
      spawnRoots: beacon.spawnRoots ?? [],
      defaultSpawnRoot: beacon.defaultSpawnRoot,
    }));
}
