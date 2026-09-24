import type { BeaconTrust, BeaconTrustStatus } from './types.js';
import { isBeaconConnected } from './beacon-ws.js';
import * as db from './db/index.js';

/**
 * Canonical beacon view shared by GET /beacons, GET /beacons/:id, and the
 * reverse-channel WS `initial` snapshot. The trust fields are derived from the
 * beacon_trust record so the shape is identical everywhere — a missing field
 * here previously left the UI's Approve gate disabled forever.
 */
export interface BeaconView {
  connected: boolean;
  trustStatus: BeaconTrustStatus | null;
  publicKey: string | null;
  verificationCode: string | null;
  fingerprintConfirmed: boolean;
}

export function buildBeaconView(
  beaconId: string,
  trust: BeaconTrust | undefined
): BeaconView {
  return {
    connected: isBeaconConnected(beaconId),
    trustStatus: trust?.status ?? null,
    publicKey: trust?.publicKey ?? null,
    verificationCode: trust?.verificationCode ?? null,
    fingerprintConfirmed: trust ? trust.fingerprintConfirmedAt !== null : false,
  };
}

/**
 * The beacon list for the reverse-channel WS `initial` snapshot: every
 * registered beacon merged with its canonical trust view, so the snapshot
 * carries the same fields as GET /beacons (no clobber when both land).
 */
export function buildInitialBeaconList(): Array<
  ReturnType<typeof db.listBeacons>[number] & BeaconView
> {
  return db.listBeacons().map(b => ({
    ...b,
    ...buildBeaconView(b.id, db.getBeaconTrust(b.id)),
  }));
}
