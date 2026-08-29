/**
 * Configuration types and helpers for the swarm plugin.
 */

/**
 * Configuration for the swarm plugin.
 */
export interface SwarmConfig {
  beaconHost?: string;
  beaconPort?: number;
  beaconUseHttps?: boolean;
  coordinatorUrl?: string;
  sessionId?: string;
}

export const DEFAULT_BEACON_HOST = 'localhost';
export const DEFAULT_BEACON_PORT = 3457;

/**
 * BeaconConfigInjector fetches config from the beacon and provides it as an underlay.
 */
export class BeaconConfigInjector {
  id = 'beacon';
  precedence = 75; // runs after coordinator (50), before agent local (100)

  private baseUrl: string;
  private cachedConfig: Record<string, unknown> = {};

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
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

      // Parse JSON values and cache
      this.cachedConfig = {};
      for (const entry of entries) {
        this.cachedConfig[entry.key] = JSON.parse(entry.value);
      }

      return this.cachedConfig;
    } catch {
      // On failure, return cached config if available
      return this.cachedConfig;
    }
  }
}
