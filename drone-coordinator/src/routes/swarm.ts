import type { FastifyInstance } from 'fastify';
import { isLargePayload, storeLargePayload } from '../storage.js';
import * as db from '../db.js';

export default function swarmRoutes(app: FastifyInstance) {
  // === Swarm Session Routes ===

  app.post<{ Body: { id: string; personaId?: string; beaconId: string } }>(
    '/sync/sessions/register',
    async (request, reply) => {
      const { id, personaId, beaconId } = request.body;
      if (!id || !beaconId) {
        return reply.code(400).send({ error: 'id and beaconId are required' });
      }
      const session = db.createSwarmSession(id, personaId ?? null, beaconId);
      return reply.code(201).send(session);
    }
  );

  app.post<{
    Body: {
      events: Array<{
        id: string;
        sessionId: string;
        correlationId?: string;
        type: string;
        payload?: string;
        metadata?: string;
        createdAt: number;
      }>;
    };
  }>('/sync/events/push', async (request, reply) => {
    const { events } = request.body;
    if (!events || !Array.isArray(events) || events.length === 0) {
      return reply.code(400).send({ error: 'events array is required' });
    }
    const created: db.SwarmEvent[] = [];
    for (const evt of events) {
      let payload = evt.payload ?? null;
      let metadata = evt.metadata ?? null;
      if (payload && isLargePayload(payload)) {
        const ref = storeLargePayload(evt.sessionId, evt.id, payload);
        payload = ref;
      }
      const event = db.createSwarmEvent({
        id: evt.id,
        sessionId: evt.sessionId,
        correlationId: evt.correlationId ?? null,
        type: evt.type,
        payload,
        metadata,
        createdAt: evt.createdAt,
      });
      created.push(event);
    }
    return reply.code(201).send({ count: created.length, events: created });
  });

  app.get<{
    Params: { id: string };
    Querystring: { correlationId?: string; limit?: number; offset?: number };
  }>('/sessions/:id/events', async (request, reply) => {
    const session = db.getSwarmSession(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    return db.getSwarmEvents(request.params.id, {
      correlationId: request.query.correlationId,
      limit: request.query.limit ? Number(request.query.limit) : undefined,
      offset: request.query.offset ? Number(request.query.offset) : undefined,
    });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
    '/sessions/:id/events/latest',
    async (request, reply) => {
      const session = db.getSwarmSession(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      const limit = request.query.limit ? Number(request.query.limit) : 10;
      return db.getLatestSwarmEvents(request.params.id, limit);
    }
  );

  app.get<{ Querystring: { q: string } }>(
    '/events/search',
    async (request, reply) => {
      const { q } = request.query;
      if (!q) {
        return reply.code(400).send({ error: 'q query parameter is required' });
      }
      return db.searchSwarmEvents(q);
    }
  );

  // === Agent Location Routes ===

  app.post<{ Body: { agentId: string; beaconId: string; personaId?: string } }>(
    '/agents/location',
    async (request, reply) => {
      const { agentId, beaconId, personaId } = request.body;
      if (!agentId || !beaconId) {
        return reply
          .code(400)
          .send({ error: 'agentId and beaconId are required' });
      }
      const location = db.registerAgentLocation(
        agentId,
        beaconId,
        personaId ?? null
      );
      return reply.code(201).send(location);
    }
  );

  app.get<{ Params: { agentId: string } }>(
    '/agents/location/:agentId',
    async (request, reply) => {
      const location = db.getAgentLocation(request.params.agentId);
      if (!location) {
        return reply.code(404).send({ error: 'Agent location not found' });
      }
      const beacon = db.getBeacon(location.beaconId);
      return {
        ...location,
        beaconHost: beacon?.host,
        beaconPort: beacon?.port,
      };
    }
  );

  app.post<{ Params: { agentId: string } }>(
    '/agents/location/:agentId/heartbeat',
    async (request, reply) => {
      const location = db.updateAgentLocationHeartbeat(request.params.agentId);
      if (!location) {
        return reply.code(404).send({ error: 'Agent location not found' });
      }
      return { success: true };
    }
  );

  app.delete<{ Params: { agentId: string } }>(
    '/agents/location/:agentId',
    async (request, reply) => {
      const deleted = db.unregisterAgentLocation(request.params.agentId);
      if (!deleted) {
        return reply.code(404).send({ error: 'Agent location not found' });
      }
      return { success: true };
    }
  );

  app.get<{ Querystring: { beaconId?: string } }>(
    '/agents/location',
    async request => {
      const { beaconId } = request.query;
      if (beaconId) {
        return db.listAgentLocationsByBeacon(beaconId);
      }
      return db.listAllAgentLocations();
    }
  );
}
