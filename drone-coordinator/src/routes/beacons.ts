import type { FastifyInstance } from 'fastify';
import { publishMutationEvent } from '../ws-pubsub.js';
import { getClientCertFingerprint } from '../mtls.js';
import { isBeaconConnected } from '../beacon-ws.js';
import { isLoopbackIp } from '../ip.js';
import type {
  RegisterBeaconRequest,
  RegisterBeaconTrustRequest,
  CreateSessionRequest,
  EndSessionRequest,
  BeaconStatusResponse,
} from '../types.js';
import * as db from '../db/index.js';
import { verifyBeaconSignature } from 'drone-swarm-common';

export default function beaconRoutes(app: FastifyInstance) {
  // === Beacon Routes (Legacy - for backwards compatibility) ===

  app.post<{ Body: RegisterBeaconRequest }>(
    '/beacons',
    async (request, reply) => {
      if (request.body.publicKey) {
        // Verify the presented client certificate matches the TLS fingerprint
        // the beacon claims. This prevents a beacon from registering with a
        // fingerprint it doesn't actually hold (spoofing).
        const presentedFingerprint = getClientCertFingerprint(request);
        if (
          request.body.tlsFingerprint &&
          presentedFingerprint &&
          presentedFingerprint !==
            request.body.tlsFingerprint.replace(/:/g, '').toLowerCase()
        ) {
          return reply.code(403).send({
            error:
              'Client certificate fingerprint does not match the claimed TLS fingerprint',
          });
        }
        const trustReq: RegisterBeaconTrustRequest = {
          id: request.body.id,
          name: request.body.name,
          host: request.body.host,
          port: request.body.port,
          publicKey: request.body.publicKey,
          tlsFingerprint: request.body.tlsFingerprint,
          fingerprintConfirmed: request.body.fingerprintConfirmed,
        };
        try {
          const trust = db.registerBeaconTrust(trustReq, {
            socketIsLocal: isLoopbackIp(request.ip),
          });
          // Also register in the beacons table so GET /beacons returns it
          db.registerBeacon({
            id: request.body.id,
            name: request.body.name,
            host: request.body.host,
            port: request.body.port,
            spawnRoots: request.body.spawnRoots,
            defaultSpawnRoot: request.body.defaultSpawnRoot,
          });
          const response: BeaconStatusResponse = { status: trust.status };
          if (trust.verificationCode) {
            response.verificationCode = trust.verificationCode;
          }
          return reply.code(201).send(response);
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.includes('Public key mismatch')
          ) {
            return reply.code(403).send({
              error: err.message,
            });
          }
          throw err;
        }
      }
      const beacon = db.registerBeacon(request.body);
      return reply.code(201).send(beacon);
    }
  );

  // Confirm the coordinator fingerprint. Called by the beacon the moment its
  // compare-only /trust-coordinator handshake matches. The signature binds the
  // announce to the beacon's Ed25519 identity (not proof-of-human — that is the
  // warning copy + the human checking the beacon id/name/host in the UI).
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/beacons/trust/:id/confirm-fingerprint',
    async (request, reply) => {
      const trust = db.getBeaconTrust(request.params.id);
      if (!trust) {
        return reply.code(404).send({ error: 'Beacon trust not found' });
      }

      const body = (request.body ?? {}) as {
        beaconId?: string;
        timestamp?: number;
        signature?: string;
      };
      if (!body.beaconId || body.beaconId !== request.params.id) {
        return reply.code(400).send({ error: 'beaconId mismatch' });
      }
      if (typeof body.timestamp !== 'number' || !body.signature) {
        return reply
          .code(400)
          .send({ error: 'timestamp and signature required' });
      }
      // Reject stale/replayed announces.
      const skew = Math.abs(Date.now() - body.timestamp);
      if (skew > 60_000) {
        return reply.code(400).send({ error: 'timestamp skew too large' });
      }

      if (
        !verifyBeaconSignature(
          trust.publicKey,
          body.beaconId + ':' + body.timestamp,
          body.signature
        )
      ) {
        return reply.code(400).send({ error: 'invalid signature' });
      }

      db.confirmBeaconFingerprint(request.params.id);
      return { success: true };
    }
  );

  app.get('/beacons', async () => {
    const beacons = db.listBeacons();
    const trustList = db.listBeaconTrust();
    const beaconsWithTrust = beacons.map(b => {
      const trust = trustList.find(t => t.beaconId === b.id);
      return {
        ...b,
        connected: isBeaconConnected(b.id),
        trustStatus: trust?.status ?? null,
        publicKey: trust?.publicKey ?? null,
        verificationCode: trust?.verificationCode ?? null,
      };
    });
    return beaconsWithTrust;
  });

  app.get<{ Params: { id: string } }>(
    '/beacons/:id',
    async (request, reply) => {
      const beacon = db.getBeacon(request.params.id);
      const trust = db.getBeaconTrust(request.params.id);
      if (!beacon && !trust) {
        return reply.code(404).send({ error: 'Beacon not found' });
      }
      return {
        ...beacon,
        connected: isBeaconConnected(request.params.id),
        beaconId: beacon?.id ?? trust?.beaconId,
        name: beacon?.name ?? trust?.name,
        host: beacon?.host ?? trust?.host,
        port: beacon?.port ?? trust?.port,
        connectedAt: beacon?.connectedAt,
        lastHeartbeat: beacon?.lastHeartbeat,
        trustStatus: trust?.status ?? null,
        publicKey: trust?.publicKey ?? null,
        verificationCode: trust?.verificationCode ?? null,
      };
    }
  );

  // === Beacon Trust Routes ===

  app.post<{ Body: RegisterBeaconTrustRequest }>(
    '/beacons/trust',
    async (request, reply) => {
      try {
        const trust = db.registerBeaconTrust(request.body, {
          socketIsLocal: isLoopbackIp(request.ip),
        });
        const response: BeaconStatusResponse = { status: trust.status };
        if (trust.verificationCode) {
          response.verificationCode = trust.verificationCode;
        }
        return reply.code(201).send(response);
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes('Public key mismatch')
        ) {
          return reply.code(403).send({
            error: err.message,
          });
        }
        throw err;
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    '/beacons/trust/:id',
    async (request, reply) => {
      const trust = db.getBeaconTrust(request.params.id);
      if (!trust) {
        return reply.code(404).send({ error: 'Beacon trust not found' });
      }
      const response: BeaconStatusResponse = {
        status: trust.status,
        fingerprintConfirmed: trust.fingerprintConfirmedAt !== null,
      };
      return response;
    }
  );

  app.get('/beacons/trust', async () => {
    return db.listBeaconTrust();
  });

  app.delete<{ Params: { id: string } }>(
    '/beacons/trust/:id',
    async (request, reply) => {
      const deleted = db.deleteBeaconTrust(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Beacon trust not found' });
      }
      return { success: true };
    }
  );

  // === Approval Routes ===
  app.post<{ Params: { id: string } }>(
    '/beacons/trust/:id/approve',
    async (request, reply) => {
      const trust = db.approveBeaconById(request.params.id);
      if (!trust) {
        const existing = db.getBeaconTrust(request.params.id);
        if (!existing) {
          return reply.code(404).send({ error: 'Beacon trust not found' });
        }
        return reply.code(409).send({
          error:
            'Beacon has not confirmed the coordinator fingerprint yet. Run /trust-coordinator <code> on the beacon first.',
        });
      }
      publishMutationEvent({
        sessionId: trust.beaconId,
        eventType: 'beacon.approved',
        payload: { beaconId: trust.beaconId },
      });
      return { success: true, beacon: trust };
    }
  );

  app.post<{ Params: { id: string } }>(
    '/beacons/trust/:id/reject',
    async (request, reply) => {
      const success = db.rejectBeacon(request.params.id);
      if (!success) {
        return reply.code(404).send({ error: 'Beacon trust not found' });
      }
      return { success: true };
    }
  );

  // === Beacon Session Routes ===

  app.post<{ Params: { id: string }; Body: CreateSessionRequest }>(
    '/beacons/:id/sessions',
    async (request, reply) => {
      const beacon = db.getBeacon(request.params.id);
      if (!beacon) {
        return reply.code(404).send({ error: 'Beacon not found' });
      }
      const session = db.createBeaconSession(request.params.id, request.body);
      publishMutationEvent({
        sessionId: request.body.agentId,
        eventType: 'beacon.session.created',
        payload: { beaconId: request.params.id, ...request.body },
      });
      return reply.code(201).send(session);
    }
  );

  app.get<{ Params: { id: string } }>(
    '/beacons/:id/sessions',
    async (request, reply) => {
      const beacon = db.getBeacon(request.params.id);
      if (!beacon) {
        return reply.code(404).send({ error: 'Beacon not found' });
      }
      return db.listBeaconSessions(request.params.id);
    }
  );

  app.get<{ Params: { id: string; agentId: string } }>(
    '/beacons/:id/sessions/:agentId',
    async (request, reply) => {
      const session = db.getBeaconSession(
        request.params.id,
        request.params.agentId
      );
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      return session;
    }
  );

  app.delete<{
    Params: { id: string; agentId: string };
    Body: EndSessionRequest;
  }>('/beacons/:id/sessions/:agentId', async (request, reply) => {
    const { disconnectedAt, durationMs } = request.body;
    const session = db.endBeaconSession(
      request.params.id,
      request.params.agentId,
      disconnectedAt,
      durationMs
    );
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    publishMutationEvent({
      sessionId: request.params.agentId,
      eventType: 'beacon.session.ended',
      payload: { beaconId: request.params.id, agentId: request.params.agentId },
    });
    return session;
  });

  // === Beacon Heartbeat ===

  app.post<{ Params: { id: string } }>(
    '/beacons/:id/heartbeat',
    async (request, reply) => {
      const beacon = db.heartbeatBeacon(request.params.id);
      if (!beacon) {
        return reply.code(404).send({ error: 'Beacon not found' });
      }
      return beacon;
    }
  );
}
