/**
 * Cached swarm description for the `# Swarm Status` prompt fragment.
 *
 * The prompt render path must never touch the network, so this store holds the
 * last known beacon identity and beacon roster and is refreshed out-of-band:
 * at plugin load, on every WS (re)connect, and on a slow interval. `render()`
 * reads this snapshot only.
 */

import type { DroneLogger } from 'drone-core';

export type SwarmBeaconInfo = {
  id: string;
  name: string;
  coordinatorHost: string | null;
  coordinatorPort: number | null;
};

export type SwarmRosterEntry = {
  id: string;
  name: string;
  host: string;
  port: number;
  connected: boolean;
  trustStatus: string | null;
};

export type SwarmInfoLogger = Pick<DroneLogger, 'warn' | 'info'>;

/** Refresh cadence for the roster + beacon identity. */
export const SWARM_INFO_REFRESH_MS = 60_000;

export interface SwarmInfoStore {
  applyBeaconInfo(info: SwarmBeaconInfo): void;
  replaceRoster(entries: SwarmRosterEntry[]): void;
  getInfo(): SwarmBeaconInfo | null;
  getRoster(): SwarmRosterEntry[];
  getLocalAddress(): string;
}

export function createSwarmInfoStore(localAddress: string): SwarmInfoStore {
  let info: SwarmBeaconInfo | null = null;
  let roster: SwarmRosterEntry[] = [];

  return {
    applyBeaconInfo(next) {
      info = next;
    },
    replaceRoster(next) {
      roster = next;
    },
    getInfo() {
      return info;
    },
    getRoster() {
      return roster;
    },
    getLocalAddress() {
      return localAddress;
    },
  };
}

function mapRosterEntry(raw: unknown): SwarmRosterEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.name !== 'string') return null;
  return {
    id: row.id,
    name: row.name,
    host: typeof row.host === 'string' ? row.host : 'unknown',
    port: typeof row.port === 'number' ? row.port : 0,
    connected: row.connected === true,
    trustStatus: typeof row.trustStatus === 'string' ? row.trustStatus : null,
  };
}

/**
 * Best-effort refresh of the beacon identity and roster. A failed request
 * leaves the previous value in place — the roster never regresses to empty on
 * an error (only a successful response replaces it).
 */
export async function refreshSwarmInfo(
  store: SwarmInfoStore,
  baseUrl: string,
  logger: SwarmInfoLogger
): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/info`);
    if (res.ok) {
      store.applyBeaconInfo((await res.json()) as SwarmBeaconInfo);
    }
  } catch (err) {
    logger.warn(`Swarm info refresh failed: ${err}`);
  }

  try {
    const res = await fetch(`${baseUrl}/coordinator/beacons`);
    if (res.ok) {
      const body = (await res.json()) as unknown;
      if (Array.isArray(body)) {
        store.replaceRoster(
          body
            .map(mapRosterEntry)
            .filter((e): e is SwarmRosterEntry => e !== null)
        );
      }
    }
  } catch (err) {
    logger.warn(`Swarm roster refresh failed: ${err}`);
  }
}

/**
 * Start the periodic swarm-info refresh. The interval is unref'd so it never
 * keeps the process alive by itself.
 */
export function startSwarmInfoRefresh(
  store: SwarmInfoStore,
  baseUrl: string,
  logger: SwarmInfoLogger
): NodeJS.Timeout {
  const interval = setInterval(() => {
    void refreshSwarmInfo(store, baseUrl, logger);
  }, SWARM_INFO_REFRESH_MS);
  interval.unref();
  return interval;
}
