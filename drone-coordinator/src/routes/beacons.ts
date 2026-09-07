import type { FastifyInstance } from 'fastify';
import { publishMutationEvent } from '../ws-pubsub.js';
import { getClientCertFingerprint } from '../mtls.js';
import { isBeaconConnected } from '../beacon-ws.js';
import type {
  RegisterBeaconRequest,
  RegisterBeaconTrustRequest,
  CreateSessionRequest,
  EndSessionRequest,
  BeaconStatusResponse,
} from '../types.js';
import * as db from '../db/index.js';

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
        };
        try {
          const trust = db.registerBeaconTrust(trustReq);
          // Also register in the beacons table so GET /beacons returns it
          db.registerBeacon({
            id: request.body.id,
            name: request.body.name,
            host: request.body.host,
            port: request.body.port,
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
        const trust = db.registerBeaconTrust(request.body);
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
      const response: BeaconStatusResponse = { status: trust.status };
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
        return reply.code(404).send({ error: 'Beacon trust not found' });
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
}
