import type { ResolvedConfigEntry } from 'drone-core';

/**
 * Memory-only overlay for coordinator config entries that carry resolved
 * secret values. Beacons must never persist these to disk (a stolen SQLite /
 * beacon_config table must yield zero secret material), so entries flagged
 * `containsSecrets` live here instead of beacon_config. A beacon restart
 * wipes this map; the next coordinator sync (boot initial sync, periodic
 * 5-minute sync, or a configChanged nudge) refills it.
 */
const secretOverlay = new Map<string, ResolvedConfigEntry>();

export function setSecretOverlay(entries: ResolvedConfigEntry[]): void {
  secretOverlay.clear();
  for (const entry of entries) {
    secretOverlay.set(entry.key, entry);
  }
}

export function overlayEntries(): ResolvedConfigEntry[] {
  return [...secretOverlay.values()];
}
