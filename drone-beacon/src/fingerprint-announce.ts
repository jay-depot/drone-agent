import { logger } from './logger.js';
import { isBeaconApproved, isCoordinatorTrusted } from './coordinator-trust.js';
import { getCoordinatorClient } from './routes/context.js';

const REANNOUNCE_INTERVAL_MS = 5 * 60 * 1000;

let lastAnnounceAt = 0;

/**
 * Announce the coordinator-fingerprint confirmation to the coordinator so its
 * approve gate unlocks. The coordinator side is idempotent. Skips when the
 * coordinator fingerprint is not trusted or the beacon is already approved;
 * otherwise throttled to one announce per REANNOUNCE_INTERVAL_MS unless
 * `force` (the explicit /trust-coordinator command bypasses the throttle).
 */
export function announceFingerprint(opts: { force?: boolean } = {}): void {
  if (!isCoordinatorTrusted() || isBeaconApproved()) {
    return;
  }
  const now = Date.now();
  if (!opts.force && now - lastAnnounceAt < REANNOUNCE_INTERVAL_MS) {
    return;
  }
  lastAnnounceAt = now;
  getCoordinatorClient()
    ?.confirmFingerprint()
    .catch(err =>
      logger.warn(`Failed to announce fingerprint confirmation: ${err}`)
    );
}

/** Test-only: reset the throttle. */
export function resetFingerprintAnnounce(): void {
  lastAnnounceAt = 0;
}
