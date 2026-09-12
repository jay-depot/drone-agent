/**
 * Configuration types and helpers for the swarm plugin.
 */

import { isUnderlayAllowed } from 'drone-core';
import { deepSet } from '../config/helpers.js';

/**
 * Configuration for the swarm plugin.
 */
export interface SwarmConfig {
  beaconHost?: string;
  beaconPort?: number;
  beaconUseHttps?: boolean;
  sessionId?: string;
}

export const DEFAULT_BEACON_HOST = 'localhost';
export const DEFAULT_BEACON_PORT = 3457;

export type FlatUnderlayMap = Record<string, unknown>;

export type NormalizedUnderlay = {
  config: Record<string, unknown>;
  skippedKeys: string[];
};

/**
 * Convert the beacon's flat dotted-key config rows into the nested
 * PartialDroneAgentConfig shape that applyAgentConfigLayer merges.
 * Keys outside the underlay allowlist (and keys deepSet rejects, e.g.
 * prototype-pollution segments) are skipped, never thrown.
 */
export function normalizeFlatUnderlay(
  flat: FlatUnderlayMap
): NormalizedUnderlay {
  const config: Record<string, unknown> = {};
  const skippedKeys: string[] = [];
  for (const [key, value] of Object.entries(flat)) {
    if (!isUnderlayAllowed(key)) {
      skippedKeys.push(key);
      continue;
    }
    try {
      deepSet(config, key, value);
    } catch {
      skippedKeys.push(key);
    }
  }
  return { config, skippedKeys };
}

/**
 * BeaconConfigInjector fetches config from the beacon and provides it as an
 * underlay. The beacon's GET /config returns the MERGED view — coordinator-
 * pushed entries (scope='swarm', pulled from the coordinator's /api/config on
 * the 5-minute sync) overlaid with beacon-local overrides, one row per key.
 * No separate coordinator injector exists: the merged view rides this single
 * beacon underlay (locked decision Q8).
 *
 * Rows are flat dotted-key entries; inject() normalizes them into the nested
 * shape rebuild() merges. Unparseable rows are dropped with a one-time
 * warning per key (passed as `warn` — the swarm plugin wires the
 * registration logger). Secret provider entries must be distributed as raw
 * `${VAR}` templates so masking never corrupts them; receiver-side
 * interpolation of underlay values is a documented follow-up (see project
 * memory seed-receiver-side-env-var-interpolation).
 */
export class BeaconConfigInjector {
  id = 'beacon';
  precedence = 75; // runs after coordinator (50), before agent local (100)

  private baseUrl: string;
  private cachedConfig: Record<string, unknown> = {};
  private warnedUnparseableKeys = new Set<string>();
  private readonly warn: (message: string) => void;

  constructor(baseUrl: string, warn: (message: string) => void = () => {}) {
    this.baseUrl = baseUrl;
    this.warn = warn;
  }

  async inject(): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(`${this.baseUrl}/config`);
      if (!response.ok) {
        throw new Error(`Failed to fetch config: ${response.status}`);
      }
      const entries = (await response.json()) as Array<{
        key: string;
        value: string;
      }>;

      const flat: FlatUnderlayMap = {};
      for (const entry of entries) {
        try {
          flat[entry.key] = JSON.parse(entry.value);
        } catch (err) {
          if (!this.warnedUnparseableKeys.has(entry.key)) {
            this.warnedUnparseableKeys.add(entry.key);
            const message = err instanceof Error ? err.message : String(err);
            this.warn(
              `Dropping unparseable beacon config entry "${entry.key}": ${message}`
            );
          }
        }
      }

      const { config } = normalizeFlatUnderlay(flat);
      this.cachedConfig = config;
      return this.cachedConfig;
    } catch {
      // On failure, return cached config if available
      return this.cachedConfig;
    }
  }
}
