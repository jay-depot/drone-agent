import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const TRUSTED_FILENAME = 'coordinator-tls-fingerprint.txt';
const PENDING_FILENAME = 'coordinator-tls-fingerprint.pending.txt';

let configDir: string | undefined;
let pendingFingerprint: string | undefined;
let trustedFingerprint: string | undefined;
let beaconApproved = false;

/**
 * Initialize the coordinator trust state from disk. Call once at startup
 * with the beacon's config directory.
 */
export function initCoordinatorTrust(dir: string): void {
  configDir = dir;
  const trustedPath = path.join(dir, TRUSTED_FILENAME);
  const pendingPath = path.join(dir, PENDING_FILENAME);

  if (fs.existsSync(trustedPath)) {
    trustedFingerprint = fs.readFileSync(trustedPath, 'utf-8').trim();
    logger.info(
      `Pinned coordinator TLS fingerprint loaded: ${trustedFingerprint}`
    );
  }
  if (fs.existsSync(pendingPath)) {
    pendingFingerprint = fs.readFileSync(pendingPath, 'utf-8').trim();
    logger.warn(
      `Coordinator TLS fingerprint awaiting confirmation: ${pendingFingerprint}. ` +
        `Run 'drone-beacon --confirm-coordinator-fingerprint <fp>' after verifying it ` +
        `matches the coordinator's reported fingerprint.`
    );
  }
}

/**
 * Record the observed coordinator fingerprint as pending (first connection).
 * Does NOT trust it until the user confirms via confirmCoordinatorFingerprint.
 */
export function setPendingCoordinatorFingerprint(fp: string): void {
  pendingFingerprint = fp;
  if (configDir) {
    fs.writeFileSync(path.join(configDir, PENDING_FILENAME), fp, 'utf-8');
  }
  logger.warn(
    `Coordinator TLS fingerprint observed (TOFU): ${fp}. ` +
      `Verify this matches the coordinator's reported fingerprint before confirming. ` +
      `Run 'drone-beacon --confirm-coordinator-fingerprint ${fp}' to trust it.`
  );
}

/**
 * Confirm the pending coordinator fingerprint, promoting it to trusted.
 * Returns true on success, false if there is no pending fingerprint or the
 * provided value does not match it.
 */
export function confirmCoordinatorFingerprint(fp: string): boolean {
  if (!pendingFingerprint) {
    logger.warn(
      'No pending coordinator fingerprint to confirm. Has the beacon connected to the coordinator yet?'
    );
    return false;
  }
  if (pendingFingerprint !== fp) {
    logger.warn(
      `Fingerprint mismatch: provided ${fp} does not match pending ${pendingFingerprint}.`
    );
    return false;
  }
  trustedFingerprint = pendingFingerprint;
  pendingFingerprint = undefined;
  if (configDir) {
    fs.writeFileSync(
      path.join(configDir, TRUSTED_FILENAME),
      trustedFingerprint,
      'utf-8'
    );
    const pendingPath = path.join(configDir, PENDING_FILENAME);
    if (fs.existsSync(pendingPath)) {
      fs.unlinkSync(pendingPath);
    }
  }
  logger.info(
    `Coordinator TLS fingerprint confirmed and pinned: ${trustedFingerprint}`
  );
  return true;
}

/**
 * True when the coordinator's TLS fingerprint has been confirmed and pinned.
 */
export function isCoordinatorTrusted(): boolean {
  return trustedFingerprint !== undefined;
}

/**
 * The confirmed coordinator TLS fingerprint, or undefined if not yet trusted.
 */
export function getTrustedCoordinatorFingerprint(): string | undefined {
  return trustedFingerprint;
}

/**
 * The pending (observed but unconfirmed) coordinator TLS fingerprint, or
 * undefined if there is none.
 */
export function getPendingCoordinatorFingerprint(): string | undefined {
  return pendingFingerprint;
}

/**
 * The coordinator TLS fingerprint observed during the most recent
 * connection — the trusted value if confirmed, otherwise the pending value.
 * Used to compute the bidirectional verification code.
 */
export function getObservedCoordinatorFingerprint(): string | undefined {
  return trustedFingerprint ?? pendingFingerprint;
}

/**
 * Record that the coordinator has approved this beacon. Swarm sync is gated
 * on both this and the fingerprint being confirmed.
 */
export function setBeaconApproved(approved: boolean): void {
  beaconApproved = approved;
}

/**
 * True when the coordinator has approved this beacon.
 */
export function isBeaconApproved(): boolean {
  return beaconApproved;
}

/**
 * True when both sides of the trust gate are satisfied: the coordinator's
 * TLS fingerprint is confirmed AND the coordinator has approved this beacon.
 */
export function isSwarmReady(): boolean {
  return trustedFingerprint !== undefined && beaconApproved;
}

/**
 * Reset all in-memory trust state. Primarily for tests.
 */
export function resetCoordinatorTrust(): void {
  configDir = undefined;
  pendingFingerprint = undefined;
  trustedFingerprint = undefined;
  beaconApproved = false;
}
