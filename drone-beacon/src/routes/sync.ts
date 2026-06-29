import type { FastifyInstance } from 'fastify';
import { triggerCoordinatorSync } from './context.js';

export default function syncRoutes(app: FastifyInstance) {
  // Trigger a sync from coordinator (manual endpoint)
  app.post('/sync', async (request, reply) => {
    const result = await triggerCoordinatorSync();
    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }
    return result;
  });
}