/**
 * Beacon self-description served by `GET /info` and pushed in the WS
 * `connected` handshake, so an agent can name the beacon it talks to and
 * locate the coordinator without additional configuration.
 *
 * Kept in a leaf module (no imports) because both the HTTP route and the
 * WebSocket server read it, and `ws-server` cannot import `routes/context`
 * without creating a cycle (`context` imports `ws-server`).
 */
export type BeaconInfo = {
  id: string;
  name: string;
  coordinatorHost: string | null;
  coordinatorPort: number | null;
};

let beaconInfo: BeaconInfo = {
  id: 'unknown',
  name: 'unknown',
  coordinatorHost: null,
  coordinatorPort: null,
};

export function setBeaconInfo(info: BeaconInfo) {
  beaconInfo = info;
}

export function getBeaconInfo(): BeaconInfo {
  return beaconInfo;
}
