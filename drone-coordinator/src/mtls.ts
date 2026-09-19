import type { FastifyRequest, FastifyReply } from 'fastify';
import { listBeaconTrust, getBeaconTrust } from './db/index.js';
import { logger } from './logger.js';

/**
 * Extract the SHA-256 fingerprint of the client certificate presented on a
 * request's TLS socket. Returns undefined when no client cert was presented
 * (e.g. plain HTTP, or HTTPS without a client cert).
 */
export function getClientCertFingerprint(
  req: FastifyRequest
): string | undefined {
  const socket = req.socket as unknown as {
    getPeerCertificate?: () => { fingerprint256?: string } | false;
  };
  const cert = socket.getPeerCertificate?.();
  if (!cert || typeof cert === 'boolean') {
    return undefined;
  }
  const raw = cert.fingerprint256;
  if (!raw) return undefined;
  return raw.replace(/:/g, '').toLowerCase();
}

/**
 * Find a beacon trust record whose TLS fingerprint matches the presented
 * client certificate. Returns the beaconId when found.
 */
export function resolveBeaconIdByFingerprint(
  fingerprint: string
): string | undefined {
  const trustList = listBeaconTrust();
  const match = trustList.find(t => t.tlsFingerprint === fingerprint);
  return match?.beaconId;
}

/**
 * Create an onRequest hook that authenticates requests to the coordinator's
 * primary API via mutual TLS. The presented client certificate's fingerprint
 * is pinned against the beacon's stored TLS fingerprint (beacon_trust).
 *
 * Exemptions:
 * - /health — health checks and the smoke test hit this without a client cert.
 * - POST /api/beacons — beacon registration is verified in-route (the beacon
 *   presents its cert and the handler checks the fingerprint matches the
 *   tlsFingerprint in the request body).
 *
 * When HTTPS is disabled the primary port is unauthenticated; a warning is
 * logged so operators know the exposure.
 */
export function createMtlsMiddleware(opts?: { httpsEnabled?: boolean }) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Health is always exempt (still rate-limited).
    if (req.url === '/health' || req.url.startsWith('/health')) {
      return;
    }

    // Bootstrap routes a PENDING beacon must still reach, verified in-route
    // rather than here (they need no approval status):
    // - POST /api/beacons — registration (cert-vs-claim checked in the handler)
    // - GET  /api/beacons/trust/:id — approval poll (deadlocks otherwise)
    // - POST /api/beacons/trust/:id/confirm-fingerprint — announce
    if (
      (req.method === 'POST' && req.url === '/api/beacons') ||
      (req.method === 'GET' &&
        req.url.startsWith('/api/beacons/trust/') &&
        req.url.endsWith('/approve') === false &&
        req.url.includes('/confirm-fingerprint') === false) ||
      (req.method === 'POST' && req.url.includes('/confirm-fingerprint'))
    ) {
      return;
    }

    // Only the primary API is mTLS-protected.
    if (!req.url.startsWith('/api')) {
      return;
    }

    if (!opts?.httpsEnabled) {
      logger.warn(
        'Primary coordinator port is running without HTTPS — mTLS is disabled and the API is unauthenticated.'
      );
      return;
    }

    const fingerprint = getClientCertFingerprint(req);
    if (!fingerprint) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'A valid client certificate is required',
      });
    }

    const beaconId = resolveBeaconIdByFingerprint(fingerprint);
    if (!beaconId) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Client certificate is not a registered beacon',
      });
    }

    // Approval status is enforced here: a PENDING beacon's certificate is in
    // beacon_trust (so the fingerprint resolves), but it must not reach data
    // routes until the coordinator's operator has approved it. The beacon
    // completes the bootstrap handshake on the exempt routes above.
    const trust = getBeaconTrust(beaconId);
    if (!trust || trust.status !== 'approved') {
      return reply.code(403).send({
        error: 'Unauthorized',
        message: 'Beacon is not yet approved',
      });
    }
  };
}
