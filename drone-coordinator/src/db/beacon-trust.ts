import { getDatabase } from './init.js';
import { generateVerificationCode } from 'drone-swarm-common';
import { logger } from '../logger.js';
import { isAutoApproveBeacons } from '../auto-approve.js';
import { getCoordinatorFingerprint } from '../routes/health.js';
import type {
  BeaconTrust,
  BeaconTrustStatus,
  RegisterBeaconTrustRequest,
} from '../types.js';

interface BeaconTrustRow {
  beacon_id: string;
  name: string;
  public_key: string;
  host: string;
  port: number;
  status: BeaconTrustStatus;
  approved_at: number | null;
  tls_fingerprint: string | null;
  fingerprint_confirmed_at: number | null;
  verification_code: string | null;
  created_at: number;
  updated_at: number;
}

function rowToBeaconTrust(row: BeaconTrustRow): BeaconTrust {
  return {
    beaconId: row.beacon_id,
    name: row.name,
    publicKey: row.public_key,
    host: row.host,
    port: row.port,
    status: row.status,
    approvedAt: row.approved_at,
    tlsFingerprint: row.tls_fingerprint,
    fingerprintConfirmedAt: row.fingerprint_confirmed_at ?? null,
    verificationCode: row.verification_code ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerBeaconTrust(
  req: RegisterBeaconTrustRequest,
  opts: { socketIsLocal?: boolean } = {}
): BeaconTrust {
  const now = Date.now();

  // Check if this beacon already has a trust record
  const existing = getBeaconTrust(req.id);
  if (existing) {
    // Verify the public key matches — this is the identity anchor
    if (existing.publicKey !== req.publicKey) {
      throw new Error(
        `Public key mismatch for beacon "${req.id}": ` +
          `stored key differs from the one presented. ` +
          `This could indicate a spoofing attempt. ` +
          `To accept the new key, delete the existing trust record first.`
      );
    }

    // Recompute the verification code from the same inputs used at first
    // registration. Re-registration runs on every beacon/coordinator restart, so
    // this keeps the persisted code fresh for beacons that predate the column
    // or that re-registered before the code was persisted.
    const verificationCode = generateVerificationCode(
      req.publicKey,
      req.tlsFingerprint ?? '',
      getCoordinatorFingerprint() ?? ''
    );
    const fingerprintConfirmedAt =
      req.fingerprintConfirmed && existing.fingerprintConfirmedAt === null
        ? now
        : existing.fingerprintConfirmedAt;

    // Update connection info but preserve status and public key
    const stmt = getDatabase().prepare(`
      UPDATE beacon_trust 
      SET host = @host, port = @port, tls_fingerprint = @tlsFingerprint, verification_code = @verificationCode, fingerprint_confirmed_at = @fingerprintConfirmedAt, updated_at = @updatedAt
      WHERE beacon_id = @beaconId
    `);

    stmt.run({
      beaconId: existing.beaconId,
      host: req.host,
      port: req.port,
      tlsFingerprint: req.tlsFingerprint ?? null,
      verificationCode,
      fingerprintConfirmedAt,
      updatedAt: now,
    });

    logger.info(
      `Re-registered beacon: ${existing.beaconId} (status: ${existing.status}, key verified)`
    );

    return {
      ...existing,
      host: req.host,
      port: req.port,
      tlsFingerprint: req.tlsFingerprint ?? null,
      fingerprintConfirmedAt,
      verificationCode,
      updatedAt: now,
    };
  }

  // Auto-approve local beacons
  const verificationCode = generateVerificationCode(
    req.publicKey,
    req.tlsFingerprint ?? '',
    getCoordinatorFingerprint() ?? ''
  );
  const isLocal = opts.socketIsLocal === true;

  // Test/integration deployments opt into auto-approval (setAutoApproveBeacons
  // at startup); the mTLS fingerprint-vs-claim anti-spoof check is unaffected.
  const status: BeaconTrustStatus =
    isLocal || isAutoApproveBeacons() ? 'approved' : 'pending';
  const approvedAt = isLocal || isAutoApproveBeacons() ? now : null;
  // A localhost beacon is the same host as the coordinator (no MITM channel),
  // so its fingerprint is considered confirmed at registration (locked Q4).
  const fingerprintConfirmedAt =
    req.fingerprintConfirmed === true || isLocal ? now : null;

  const trust: BeaconTrust = {
    beaconId: req.id,
    name: req.name,
    publicKey: req.publicKey,
    host: req.host,
    port: req.port,
    status,
    approvedAt,
    tlsFingerprint: req.tlsFingerprint ?? null,
    fingerprintConfirmedAt,
    verificationCode,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO beacon_trust 
    (beacon_id, name, public_key, host, port, status, approved_at, tls_fingerprint, fingerprint_confirmed_at, verification_code, created_at, updated_at)
    VALUES (@beaconId, @name, @publicKey, @host, @port, @status, @approvedAt, @tlsFingerprint, @fingerprintConfirmedAt, @verificationCode, @createdAt, @updatedAt)
  `);

  stmt.run({
    beaconId: trust.beaconId,
    name: trust.name,
    publicKey: trust.publicKey,
    host: trust.host,
    port: trust.port,
    status: trust.status,
    approvedAt: trust.approvedAt,
    tlsFingerprint: trust.tlsFingerprint,
    fingerprintConfirmedAt: trust.fingerprintConfirmedAt,
    verificationCode: trust.verificationCode,
    createdAt: trust.createdAt,
    updatedAt: trust.updatedAt,
  });

  logger.info(
    `Registered beacon trust: ${trust.beaconId} (status: ${trust.status})`
  );
  return trust;
}

export function getBeaconTrust(beaconId: string): BeaconTrust | undefined {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_trust WHERE beacon_id = ?'
  );
  const row = stmt.get(beaconId) as BeaconTrustRow | undefined;
  if (!row) return undefined;
  return rowToBeaconTrust(row);
}

export function listBeaconTrust(): BeaconTrust[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_trust ORDER BY name'
  );
  const rows = stmt.all() as BeaconTrustRow[];
  return rows.map(rowToBeaconTrust);
}

export function approveBeaconById(beaconId: string): BeaconTrust | null {
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_trust 
    SET status = 'approved', approved_at = ?, updated_at = ?
    WHERE beacon_id = ? AND status = 'pending' AND fingerprint_confirmed_at IS NOT NULL
  `);
  const result = stmt.run(now, now, beaconId);

  if (result.changes === 0) {
    return null;
  }

  const updated = getBeaconTrust(beaconId);
  if (!updated) return null;

  logger.info(`Approved beacon: ${updated.beaconId}`);
  return updated;
}

export function confirmBeaconFingerprint(beaconId: string): BeaconTrust | null {
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_trust
    SET fingerprint_confirmed_at = ?, updated_at = ?
    WHERE beacon_id = ?
  `);
  const result = stmt.run(now, now, beaconId);
  if (result.changes === 0) {
    return null;
  }
  const updated = getBeaconTrust(beaconId);
  if (!updated) return null;
  logger.info(`Beacon confirmed coordinator fingerprint: ${updated.beaconId}`);
  return updated;
}

export function rejectBeacon(beaconId: string): boolean {
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_trust 
    SET status = 'rejected', updated_at = ?
    WHERE beacon_id = ?
  `);
  const result = stmt.run(now, beaconId);
  if (result.changes > 0) {
    logger.info(`Rejected beacon: ${beaconId}`);
  }
  return result.changes > 0;
}

export function deleteBeaconTrust(beaconId: string): boolean {
  const stmt = getDatabase().prepare(
    'DELETE FROM beacon_trust WHERE beacon_id = ?'
  );
  const result = stmt.run(beaconId);
  logger.info(`Deleted beacon trust: ${beaconId}`);
  return result.changes > 0;
}
