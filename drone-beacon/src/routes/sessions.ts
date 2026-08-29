import type { FastifyInstance } from 'fastify';
import { getCoordinatorClient } from './context.js';

/**
 * Beacon proxy routes for coordinator session reads.
 *
 * The agent hits these beacon routes instead of the coordinator directly, so
 * the beacon is the sole coordinator-facing trust gate. The beacon forwards
 * to the coordinator via its typed CoordinatorClient and passes the response
 * through unchanged.
 */
export default function sessionRoutes(app: FastifyInstance) {
  // List swarm sessions from the coordinator
  app.get<{
    Querystring: { limit?: string; status?: string };
  }>('/sessions', async (request, reply) => {
    const client = getCoordinatorClient();
    if (!client) {
      return reply.code(503).send({ error: 'Coordinator not configured' });
    }
    const query: Record<string, string> = {};
    if (request.query.limit) query.limit = request.query.limit;
    if (request.query.status) query.status = request.query.status;
    return client.getSessions(query);
  });

  // Fetch a session's transcript from the coordinator
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/transcript',
    async (request, reply) => {
      const client = getCoordinatorClient();
      if (!client) {
        return reply.code(503).send({ error: 'Coordinator not configured' });
      }
      const result = await client.getSessionTranscript(request.params.id);
      if (!result) {
        return reply.code(503).send({ error: 'Coordinator unavailable' });
      }
      return result;
    }
  );
}
