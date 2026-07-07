import crypto from 'node:crypto';
import { getDatabase } from './init.js';
import { logger } from '../logger.js';
import type {
  BeaconTrust,
  BeaconTrustStatus,
  RegisterBeaconTrustRequest,
} from '../types.js';

function generateApprovalToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function registerBeaconTrust(
  req: RegisterBeaconTrustRequest
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

    // Update connection info but preserve status and public key
    const stmt = getDatabase().prepare(`
      UPDATE beacon_trust 
      SET host = @host, port = @port, tls_fingerprint = @tlsFingerprint, updated_at = @updatedAt
      WHERE beacon_id = @beaconId
    `);

    stmt.run({
      beaconId: existing.beaconId,
      host: req.host,
      port: req.port,
      tlsFingerprint: req.tlsFingerprint ?? null,
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
      updatedAt: now,
    };
  }

  const isLocal = req.host === 'localhost' || req.host === '127.0.0.1';

  // Auto-approve local beacons
  const status: BeaconTrustStatus = isLocal ? 'approved' : 'pending';
  const approvalToken = isLocal ? null : generateApprovalToken();

  const trust: BeaconTrust = {
    beaconId: req.id,
    name: req.name,
    publicKey: req.publicKey,
    host: req.host,
    port: req.port,
    status,
    approvalToken,
    approvedAt: isLocal ? now : null,
    tlsFingerprint: req.tlsFingerprint ?? null,
    createdAt: now,
    updatedAt: now,
  };

  const stmt = getDatabase().prepare(`
    INSERT INTO beacon_trust 
    (beacon_id, name, public_key, host, port, status, approval_token, approved_at, tls_fingerprint, created_at, updated_at)
    VALUES (@beaconId, @name, @publicKey, @host, @port, @status, @approvalToken, @approvedAt, @tlsFingerprint, @createdAt, @updatedAt)
  `);

  stmt.run({
    beaconId: trust.beaconId,
    name: trust.name,
    publicKey: trust.publicKey,
    host: trust.host,
    port: trust.port,
    status: trust.status,
    approvalToken: trust.approvalToken,
    approvedAt: trust.approvedAt,
    tlsFingerprint: trust.tlsFingerprint,
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
  const row = stmt.get(beaconId) as
    | {
        beacon_id: string;
        name: string;
        public_key: string;
        host: string;
        port: number;
        status: BeaconTrustStatus;
        approval_token: string | null;
        approved_at: number | null;
        tls_fingerprint: string | null;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  if (!row) return undefined;
  return {
    beaconId: row.beacon_id,
    name: row.name,
    publicKey: row.public_key,
    host: row.host,
    port: row.port,
    status: row.status,
    approvalToken: row.approval_token,
    approvedAt: row.approved_at,
    tlsFingerprint: row.tls_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listBeaconTrust(): BeaconTrust[] {
  const stmt = getDatabase().prepare(
    'SELECT * FROM beacon_trust ORDER BY name'
  );
  const rows = stmt.all() as Array<{
    beacon_id: string;
    name: string;
    public_key: string;
    host: string;
    port: number;
    status: BeaconTrustStatus;
    approval_token: string | null;
    approved_at: number | null;
    tls_fingerprint: string | null;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map(row => ({
    beaconId: row.beacon_id,
    name: row.name,
    publicKey: row.public_key,
    host: row.host,
    port: row.port,
    status: row.status,
    approvalToken: row.approval_token,
    approvedAt: row.approved_at,
    tlsFingerprint: row.tls_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function approveBeacon(approvalToken: string): BeaconTrust | null {
  const now = Date.now();

  // First, find the beacon_id for this token before updating
  const findStmt = getDatabase().prepare(
    'SELECT beacon_id FROM beacon_trust WHERE approval_token = ? AND status = ?'
  );
  const found = findStmt.get(approvalToken, 'pending') as
    | { beacon_id: string }
    | undefined;
  if (!found) return null;

  const stmt = getDatabase().prepare(`
    UPDATE beacon_trust 
    SET status = 'approved', approval_token = NULL, approved_at = ?, updated_at = ?
    WHERE approval_token = ? AND status = 'pending'
  `);
  const result = stmt.run(now, now, approvalToken);

  if (result.changes === 0) {
    return null;
  }

  // Fetch the updated trust by beacon_id
  const stmt2 = getDatabase().prepare(
    'SELECT * FROM beacon_trust WHERE beacon_id = ?'
  );
  const row = stmt2.get(found.beacon_id) as
    | {
        beacon_id: string;
        name: string;
        public_key: string;
        host: string;
        port: number;
        status: BeaconTrustStatus;
        approval_token: string | null;
        approved_at: number | null;
        tls_fingerprint: string | null;
        created_at: number;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;

  logger.info(`Approved beacon: ${row.beacon_id}`);
  return {
    beaconId: row.beacon_id,
    name: row.name,
    publicKey: row.public_key,
    host: row.host,
    port: row.port,
    status: row.status,
    approvalToken: row.approval_token,
    approvedAt: row.approved_at,
    tlsFingerprint: row.tls_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rejectBeacon(beaconId: string): boolean {
  const now = Date.now();
  const stmt = getDatabase().prepare(`
    UPDATE beacon_trust 
    SET status = 'rejected', approval_token = NULL, updated_at = ?
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
