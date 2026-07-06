import type { FastifyInstance } from 'fastify';
import { getCoordinatorClient } from './context.js';
import { triggerCoordinatorSync } from './context.js';
import { logger } from '../logger.js';

export default function syncRoutes(app: FastifyInstance) {
  // Trigger a sync from coordinator (manual endpoint)
  app.post('/sync', async (_request, reply) => {
    const result = await triggerCoordinatorSync();
    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }
    return result;
  });

  // Proxy conversation events to coordinator
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
    const client = getCoordinatorClient();
    if (client) {
      client.pushEvents(events).catch(err => {
        logger.warn(`Failed to proxy events to coordinator: ${err}`);
      });
    }
    return reply.code(201).send({ count: events.length });
  });

  // Proxy swarm session registration to coordinator
  app.post<{
    Body: { id: string; personaId?: string; beaconId: string };
  }>('/sync/sessions/register', async (request, reply) => {
    const { id, personaId, beaconId } = request.body;
    if (!id || !beaconId) {
      return reply.code(400).send({ error: 'id and beaconId are required' });
    }
    const client = getCoordinatorClient();
    if (client) {
      client.registerSwarmSession(id, personaId ?? null).catch(err => {
        logger.warn(
          `Failed to proxy session registration to coordinator: ${err}`
        );
      });
    }
    return reply.code(201).send({ id, status: 'active' });
  });

  // Proxy swarm session end to coordinator
  app.delete<{ Params: { id: string } }>(
    '/sync/sessions/:id',
    async (request, reply) => {
      const client = getCoordinatorClient();
      if (!client) {
        return reply.code(502).send({ error: 'Coordinator not configured' });
      }
      await client.endSwarmSession(request.params.id);
      return { success: true };
    }
  );
}
