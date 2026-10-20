import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  buildRedemptionSignaturePayload,
  buildTokenSignaturePayload,
  generateBurnKey,
  signBeaconPayload,
  verifyBeaconSignature,
  PRE_APPROVAL_TOKEN_TTL_MS,
  type PreApprovalToken,
} from 'drone-swarm-common';
import { getSigningIdentity } from '../signing-identity.js';
import { getCoordinatorFingerprint } from './health.js';
import { publishMutationEvent } from '../ws-pubsub.js';
import * as db from '../db/index.js';

interface RedemptionBody {
  durableId?: string;
  clientKey?: string;
  pubKey?: string;
  sig?: string;
}

export default function preApprovalTokenRoutes(app: FastifyInstance) {
  app.post<{ Body: RedemptionBody }>(
    '/beacons/trust/redeem',
    async (request, reply) => {
      const { durableId, clientKey, pubKey, sig } = request.body ?? {};
      if (!durableId || !clientKey || !pubKey || !sig) {
        return reply
          .code(400)
          .send({ error: 'Invalid redemption request', code: 'INVALID_REQUEST' });
      }
      const token = db.getPreApprovalToken(durableId);
      if (!token) {
        return reply
          .code(404)
          .send({ error: 'Unknown token', code: 'TOKEN_NOT_FOUND' });
      }
      if (token.expiresAt < Date.now()) {
        return reply
          .code(410)
          .send({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
      }
      const payload = buildRedemptionSignaturePayload({
        durableId,
        clientKey,
        pubKey,
      });
      if (!verifyBeaconSignature(token.burnPublicKey, payload, sig)) {
        return reply
          .code(400)
          .send({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
      }
      const trust = db.getBeaconTrustByPublicKey(clientKey);
      if (!trust) {
        return reply
          .code(404)
          .send({ error: 'Client is not registered', code: 'CLIENT_NOT_REGISTERED' });
      }
      if (!db.burnPreApprovalToken(durableId, trust.beaconId, Date.now())) {
        return reply
          .code(409)
          .send({ error: 'Token already used', code: 'TOKEN_ALREADY_BURNED' });
      }
      db.confirmBeaconFingerprint(trust.beaconId);
      db.approveBeaconById(trust.beaconId);
      publishMutationEvent({
        sessionId: trust.beaconId,
        eventType: 'beacon.approved',
        payload: { beaconId: trust.beaconId },
      });
      return reply
        .code(200)
        .send({ status: 'approved', beaconId: trust.beaconId });
    }
  );

  app.post('/pre-approval-tokens', async (request, reply) => {
    const identity = getSigningIdentity();
    if (!identity) {
      return reply
        .code(500)
        .send({ error: 'Coordinator signing identity is not available' });
    }
    const body = (request.body ?? {}) as { label?: string };
    const durableId = randomUUID();
    const burn = generateBurnKey();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + PRE_APPROVAL_TOKEN_TTL_MS;
    const label = body.label ?? null;
    const base = {
      durableId,
      pubKey: identity.publicKey,
      tlsFingerprint: getCoordinatorFingerprint() ?? '',
      burnKey: burn.privateKeyPem,
    };
    const token: PreApprovalToken = {
      ...base,
      sig: signBeaconPayload(
        identity.privateKeyPem,
        buildTokenSignaturePayload(base)
      ),
    };
    db.createPreApprovalToken({
      durableId,
      burnPublicKey: burn.publicKey,
      label,
      issuedAt,
      expiresAt,
    });
    return reply.code(201).send({
      token,
      entry: {
        durableId,
        label,
        issuedAt,
        expiresAt,
        burnedAt: null,
        burnedBy: null,
      },
    });
  });

  app.get('/pre-approval-tokens', async () => {
    return db.listPreApprovalTokens().map(t => ({
      durableId: t.durableId,
      label: t.label,
      issuedAt: t.issuedAt,
      expiresAt: t.expiresAt,
      burnedAt: t.burnedAt,
      burnedBy: t.burnedBy,
    }));
  });

  app.delete<{ Params: { durableId: string } }>(
    '/pre-approval-tokens/:durableId',
    async (request, reply) => {
      const revoked = db.deletePreApprovalToken(request.params.durableId);
      if (!revoked) {
        return reply
          .code(404)
          .send({ error: 'Unknown token', code: 'TOKEN_NOT_FOUND' });
      }
      return reply.code(200).send({ revoked: true });
    }
  );
}
