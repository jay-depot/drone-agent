export type SwarmTarget = 'beacon' | 'coordinator';

const DEFAULT_COORDINATOR_PORT = 3456;
const DEFAULT_BEACON_PORT = 3457;

export interface ResolvedAddress {
  target: SwarmTarget;
  baseUrl: string;
}

export class AddressError extends Error {}

function normalizeBaseUrl(raw: string): string {
  const withProtocol = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withProtocol);
  url.search = '';
  url.hash = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname === '/') {
    pathname = '';
  }
  return `${url.protocol}//${url.host}${pathname}`;
}

/**
 * Resolve the swarm server address from, in order of precedence: explicit
 * --beacon/--coordinator flags, DRONE_BEACON_URL/DRONE_COORDINATOR_URL
 * environment variables, then a local default (coordinator first, falling
 * back to the beacon). Exactly one of the two flags may be given; they pick
 * both the address and the route dialect.
 */
export function resolveAddress(options: {
  beacon?: string;
  coordinator?: string;
}): ResolvedAddress {
  if (options.beacon && options.coordinator) {
    throw new AddressError(
      '--beacon and --coordinator are mutually exclusive; pass exactly one'
    );
  }
  if (options.beacon) {
    return { target: 'beacon', baseUrl: normalizeBaseUrl(options.beacon) };
  }
  if (options.coordinator) {
    return {
      target: 'coordinator',
      baseUrl: normalizeBaseUrl(options.coordinator),
    };
  }
  const envBeacon = process.env.DRONE_BEACON_URL;
  const envCoordinator = process.env.DRONE_COORDINATOR_URL;
  if (envBeacon && envCoordinator) {
    throw new Error(
      'Both DRONE_BEACON_URL and DRONE_COORDINATOR_URL are set; unset one or pass --beacon/--coordinator explicitly'
    );
  }
  if (envCoordinator) {
    return {
      target: 'coordinator',
      baseUrl: normalizeBaseUrl(envCoordinator),
    };
  }
  if (envBeacon) {
    return { target: 'beacon', baseUrl: normalizeBaseUrl(envBeacon) };
  }
  return {
    target: 'coordinator',
    baseUrl: `http://localhost:${DEFAULT_COORDINATOR_PORT}`,
  };
}

/** Default address used when a target is selected but no URL was provided. */
export function defaultUrlFor(target: SwarmTarget): string {
  return target === 'coordinator'
    ? `http://localhost:${DEFAULT_COORDINATOR_PORT}`
    : `http://localhost:${DEFAULT_BEACON_PORT}`;
}
